import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import type { Queue } from 'bullmq';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { adminAuth } from '../admin/auth.js';
import { InvalidCursorError } from '../admin/leads.js';
import { InvalidSubjectError, type AdminService } from '../admin/service.js';
import { LeadStatus, LeadTier } from '../generated/prisma/client.js';

export interface AdminDeps {
  token: string;
  service: AdminService;
  /** Queues shown in the Bull Board UI at /admin/queues; the UI is off when unset. */
  boardQueues?: Queue[];
}

const DAY = 24 * 60 * 60_000;

// "a,b" query values → ["a", "b"]
const csv = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z.array(item).min(1),
  );
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const leadsQuery = z.object({
  status: csv(z.enum(LeadStatus)).optional(),
  tier: csv(z.enum(LeadTier)).optional(),
  source: z.string().min(1).optional(),
  q: z.string().min(1).max(200).optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  crmSyncFailed: bool.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

const metricsQuery = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    source: z.string().min(1).optional(),
  })
  .transform(({ from, to = new Date(), source }) => ({
    from: from ?? new Date(to.getTime() - 30 * DAY),
    to,
    source,
  }))
  .refine((r) => r.from < r.to, { message: '`from` must be before `to`' })
  .refine((r) => r.to.getTime() - r.from.getTime() <= 366 * DAY, {
    message: 'The range can span at most 366 days',
  });

const subjectBody = z
  .object({ email: z.string().max(320).optional(), phone: z.string().max(40).optional() })
  .refine((b) => b.email !== undefined || b.phone !== undefined, {
    message: 'Give an email and/or a phone',
  });
const eraseBody = z
  .object({
    email: z.string().max(320).optional(),
    phone: z.string().max(40).optional(),
    leadIds: z.array(z.uuid()).min(1).max(1000).optional(),
    /** Also permanently delete the contacts from the CRM. */
    deleteFromCrm: z.boolean().default(false),
    /** Erasure can't be undone. */
    confirm: z.literal(true),
  })
  .refine((b) => b.email !== undefined || b.phone !== undefined || b.leadIds, {
    message: 'Give an email, a phone and/or leadIds',
  });

const idParams = z.object({ id: z.uuid() });
const pauseBody = z.object({ reason: z.string().max(500).optional() }).optional();
const requeueBody = z.object({ leadIds: z.array(z.uuid()).min(1).max(1000).optional() }).optional();

function parse<T extends z.ZodType>(
  schema: T,
  value: unknown,
  reply: FastifyReply,
): z.infer<T> | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  void reply.code(400).send({ error: 'invalid_request', details: z.treeifyError(result.error) });
  return undefined;
}

/**
 * Operator endpoints under /admin, all behind the admin token: lead search and timelines,
 * pausing follow-ups, queue repair, metrics, current alerts, and the Bull Board UI.
 */
export const adminRoutes: FastifyPluginAsync<AdminDeps> = async (
  app,
  { token, service, boardQueues },
) => {
  app.addHook('onRequest', adminAuth(token));

  app.get('/api/leads', async (request, reply) => {
    const filters = parse(leadsQuery, request.query, reply);
    if (!filters) return reply;
    try {
      return await service.listLeads(filters);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return reply.code(400).send({ error: 'invalid_cursor' });
      }
      throw err;
    }
  });

  app.get('/api/leads/:id', async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params) return reply;
    const lead = await service.getLead(params.id);
    return lead ?? reply.code(404).send({ error: 'not_found' });
  });

  for (const action of ['pause', 'resume'] as const) {
    app.post(`/api/enrollments/:id/${action}`, async (request, reply) => {
      const params = parse(idParams, request.params, reply);
      if (!params) return reply;
      let outcome;
      if (action === 'pause') {
        const body = parse(pauseBody, request.body, reply);
        if (reply.sent) return reply;
        outcome = await service.pauseEnrollment(params.id, body?.reason);
      } else {
        outcome = await service.resumeEnrollment(params.id);
      }
      switch (outcome.status) {
        case 'not_found':
          return reply.code(404).send({ error: 'not_found' });
        case 'conflict':
          return reply.code(409).send({
            error: 'invalid_state',
            message: `Only ${action === 'pause' ? 'active' : 'paused'} enrollments can be ${action}d`,
            current: outcome.current,
          });
        default:
          request.log.info({ ...outcome }, `enrollment ${outcome.status}`);
          return outcome;
      }
    });
  }

  app.get('/api/queues', async () => ({ queues: await service.queueStats() }));

  app.post('/api/queues/:name/retry-failed', async (request, reply) => {
    const { name } = request.params as { name: string };
    const retried = await service.retryFailed(name);
    if (retried === null) return reply.code(404).send({ error: 'unknown_queue' });
    request.log.info({ queue: name, retried }, 'failed jobs retried');
    return { queue: name, retried };
  });

  app.post('/api/crm/requeue', async (request, reply) => {
    const body = parse(requeueBody, request.body, reply);
    if (reply.sent) return reply;
    const requeued = await service.requeueCrmDeadLetters(body?.leadIds);
    request.log.info({ requeued, leadIds: body?.leadIds }, 'crm dead letters requeued');
    return { requeued };
  });

  app.get('/api/metrics', async (request, reply) => {
    const range = parse(metricsQuery, request.query, reply);
    if (!range) return reply;
    return service.metrics(range);
  });

  app.get('/api/alerts', async () => ({ alerts: await service.alerts() }));

  // Data-subject requests (LGPD art. 18 / GDPR arts. 15, 17). POST keeps personal data out of
  // URLs and access logs; the logs below only carry counts.
  const invalidSubject = (reply: FastifyReply, err: InvalidSubjectError) =>
    reply.code(400).send({ error: 'invalid_subject', message: err.message });

  app.post('/api/privacy/export', async (request, reply) => {
    const body = parse(subjectBody, request.body, reply);
    if (!body) return reply;
    try {
      const data = await service.exportSubject(body);
      request.log.info({ leads: data.leads.length }, 'privacy export');
      return data;
    } catch (err) {
      if (err instanceof InvalidSubjectError) return invalidSubject(reply, err);
      throw err;
    }
  });

  app.post('/api/privacy/erase', async (request, reply) => {
    const body = parse(eraseBody, request.body, reply);
    if (!body) return reply;
    const { email, phone, leadIds, deleteFromCrm } = body;
    try {
      const result = await service.eraseSubject({
        subject: email !== undefined || phone !== undefined ? { email, phone } : undefined,
        leadIds,
        deleteFromCrm,
      });
      request.log.info({ ...result, deleteFromCrm }, 'privacy erasure');
      return result;
    } catch (err) {
      if (err instanceof InvalidSubjectError) return invalidSubject(reply, err);
      throw err;
    }
  });

  if (boardQueues) {
    const serverAdapter = new FastifyAdapter();
    serverAdapter.setBasePath('/admin/queues');
    createBullBoard({
      queues: boardQueues.map((queue) => new BullMQAdapter(queue)),
      serverAdapter,
      options: { uiConfig: { boardTitle: 'LeadFlow' } },
    });
    await app.register(serverAdapter.registerPlugin(), { prefix: '/queues' });
  }
};
