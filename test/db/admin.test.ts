// Runs against the real Postgres (and Redis for the queue cases): `npm run test:db`.
// Skipped when DATABASE_URL is not set, e.g. in CI.
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateAlerts } from '../../src/admin/alerts.js';
import { InvalidCursorError, getLead, listLeads } from '../../src/admin/leads.js';
import { computeMetrics } from '../../src/admin/metrics.js';
import { createAdminService } from '../../src/admin/service.js';
import { buildApp } from '../../src/app.js';
import { dryRunCrmAdapter } from '../../src/crm/adapters/dryRun.js';
import { createDb } from '../../src/db.js';
import {
  followUpKey,
  pauseEnrollment,
  resumeEnrollment,
  stopEnrollments,
} from '../../src/followup/enrollment.js';
import { createRunFollowUpStep } from '../../src/followup/runStep.js';
import type { LeadEventType, Prisma } from '../../src/generated/prisma/client.js';
import { WORK_QUEUES, createQueueMonitor } from '../../src/queue.js';
import { fakeQueue, testAppDeps } from '../helpers.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const privacyDeps = {
  crm: dryRunCrmAdapter({ info: () => {} }),
  defaultCountry: 'BR' as const,
};
const thresholds = { queueBacklog: 1e9, queueWaitMinutes: 1e9, sendFailures: 2, windowMinutes: 15 };

describe.skipIf(!databaseUrl)('admin (database)', () => {
  const db = createDb(databaseUrl!);
  const leadIds = new Set<string>();
  const suffix = randomUUID().slice(0, 8);
  // A unique source keeps other tests' leads out of the filtered queries and metrics.
  const source = `t_admin_${suffix}`;
  const template = `t_admin_${suffix}`;
  const sequence = `t_admin_seq_${suffix}`;
  let sequenceId: string;

  beforeAll(async () => {
    await db.template.create({
      data: { name: template, channel: 'email', subject: 'Hi', body: 'Hello' },
    });
    const created = await db.sequence.create({
      data: {
        name: sequence,
        tier: 'hot',
        steps: {
          create: [
            {
              order: 1,
              offsetMinutes: 60,
              channel: 'email',
              template: { connect: { name: template } },
            },
            {
              order: 2,
              offsetMinutes: 1440,
              channel: 'email',
              template: { connect: { name: template } },
            },
          ],
        },
      },
    });
    sequenceId = created.id;
  });

  afterAll(async () => {
    await db.lead.deleteMany({ where: { id: { in: [...leadIds] } } });
    await db.sequence.deleteMany({ where: { name: sequence } });
    await db.template.deleteMany({ where: { name: template } });
    await db.$disconnect();
  });

  async function createLead(data: Partial<Prisma.LeadCreateInput> = {}) {
    const lead = await db.lead.create({ data: { source, rawPayload: {}, ...data } });
    leadIds.add(lead.id);
    return lead;
  }

  async function addEvent(
    leadId: string,
    type: LeadEventType,
    at: Date,
    extra: Partial<Prisma.LeadEventUncheckedCreateInput> = {},
  ) {
    return db.leadEvent.create({ data: { leadId, type, createdAt: at, ...extra } });
  }

  async function enroll(leadId: string, nextRunAt: Date, status: 'active' | 'paused' = 'active') {
    return db.enrollment.create({
      data: { leadId, sequenceId, currentStep: 1, nextRunAt, status },
    });
  }

  describe('listLeads', () => {
    const base = new Date('2020-03-01T12:00:00Z');

    it('filters, searches and pages newest first with stable ties', async () => {
      const at = (min: number) => new Date(base.getTime() + min * MINUTE);
      const a = await createLead({
        createdAt: at(0),
        status: 'contacted',
        tier: 'hot',
        email: 'ana@example.com',
      });
      const b = await createLead({ createdAt: at(1), status: 'engaged', tier: 'warm' });
      // Same createdAt: ordered by id.
      const c = await createLead({ createdAt: at(2), status: 'contacted', tier: 'hot' });
      const d = await createLead({
        createdAt: at(2),
        status: 'contacted',
        tier: 'cold',
        company: 'ACME Ltd',
      });
      await createLead({ createdAt: at(3), status: 'do_not_contact', tier: 'hot' });

      const all = await listLeads(db, { source, limit: 100, createdFrom: base, createdTo: at(10) });
      expect(all.leads).toHaveLength(5);
      expect(all.leads.map((l) => l.createdAt.getTime())).toEqual(
        [...all.leads.map((l) => l.createdAt.getTime())].sort((x, y) => y - x),
      );

      const contacted = await listLeads(db, { source, status: ['contacted'], limit: 100 });
      expect(contacted.leads.map((l) => l.id).sort()).toEqual([a.id, c.id, d.id].sort());

      const hotOrWarm = await listLeads(db, {
        source,
        tier: ['hot', 'warm'],
        status: ['contacted', 'engaged'],
        limit: 100,
      });
      expect(hotOrWarm.leads.map((l) => l.id).sort()).toEqual([a.id, b.id, c.id].sort());

      expect(
        (await listLeads(db, { source, q: 'ANA@EXAMPLE', limit: 10 })).leads.map((l) => l.id),
      ).toEqual([a.id]);
      expect(
        (await listLeads(db, { source, q: 'acme', limit: 10 })).leads.map((l) => l.id),
      ).toEqual([d.id]);

      // Page through two at a time: every lead once, same order as the single page.
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const result = await listLeads(db, {
          source,
          limit: 2,
          createdFrom: base,
          createdTo: at(10),
          cursor,
        });
        seen.push(...result.leads.map((l) => l.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      expect(seen).toEqual(all.leads.map((l) => l.id));
      // The summary leaves out the raw payload.
      expect(all.leads[0]).not.toHaveProperty('rawPayload');
    });

    it('filters dead-lettered CRM syncs', async () => {
      const failed = await createLead({ crmSyncFailedAt: new Date(), crmSyncError: 'boom' });
      const result = await listLeads(db, { source, crmSyncFailed: true, limit: 100 });
      expect(result.leads.map((l) => l.id)).toEqual([failed.id]);
    });

    it('rejects a malformed cursor', async () => {
      await expect(listLeads(db, { limit: 10, cursor: 'garbage' })).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    });
  });

  describe('getLead', () => {
    it('returns the lead, its enrollments and the timeline oldest first', async () => {
      const lead = await createLead({ status: 'contacted', tier: 'hot' });
      const t = new Date('2020-04-01T10:00:00Z');
      const captured = await addEvent(lead.id, 'captured', t);
      // Two events in one transaction share createdAt.
      const e1 = await addEvent(lead.id, 'scored', new Date(t.getTime() + MINUTE));
      const e2 = await addEvent(lead.id, 'enrolled', new Date(t.getTime() + MINUTE));
      await enroll(lead.id, new Date(t.getTime() + HOUR));

      const result = await getLead(db, lead.id);
      expect(result?.lead.id).toBe(lead.id);
      expect(result?.enrollments).toEqual([
        expect.objectContaining({ sequence, sequenceTier: 'hot', status: 'active' }),
      ]);
      expect(result?.timeline.truncated).toBe(false);
      expect(result?.timeline.events.map((e) => e.id)).toEqual([
        captured.id,
        ...[e1.id, e2.id].sort(),
      ]);
    });

    it('returns null for an unknown lead', async () => {
      expect(await getLead(db, randomUUID())).toBeNull();
    });
  });

  describe('pause and resume', () => {
    it('pauses: step jobs skip it; resume reschedules an overdue step for now', async () => {
      const lead = await createLead({ status: 'contacted', tier: 'hot' });
      const due = new Date(Date.now() - HOUR);
      const enrollment = await enroll(lead.id, due);

      expect(await pauseEnrollment(db, enrollment.id, 'on a call')).toEqual({
        status: 'paused',
        enrollmentId: enrollment.id,
        leadId: lead.id,
      });
      expect(await pauseEnrollment(db, enrollment.id)).toEqual({
        status: 'conflict',
        current: 'paused',
      });

      const queue = fakeQueue();
      const runStep = createRunFollowUpStep({
        db,
        queue,
        quietHours: { start: '00:00', end: '00:00', channels: [], defaultTimezone: 'UTC' },
      });
      expect(await runStep({ enrollmentId: enrollment.id, step: 1, runAt: due.getTime() })).toEqual(
        { status: 'skipped', reason: 'enrollment is paused' },
      );
      expect(queue.enqueueSendMessage).not.toHaveBeenCalled();

      const now = new Date();
      const resumed = await resumeEnrollment(db, enrollment.id, now);
      expect(resumed).toEqual({
        status: 'resumed',
        enrollmentId: enrollment.id,
        leadId: lead.id,
        job: { enrollmentId: enrollment.id, step: 1, runAt: now.getTime() },
      });
      expect(await resumeEnrollment(db, enrollment.id)).toEqual({
        status: 'conflict',
        current: 'active',
      });

      // The resumed step now runs and queues its message.
      const outcome = await runStep(resumed.job!);
      expect(outcome.status).toBe('queued');
      expect(queue.enqueueSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ dedupeKey: followUpKey(enrollment.id, 1) }),
        expect.anything(),
      );

      const events = await db.leadEvent.findMany({
        where: { leadId: lead.id, type: { in: ['sequence_paused', 'sequence_resumed'] } },
        orderBy: { createdAt: 'asc' },
      });
      expect(events.map((e) => [e.type, e.payload])).toEqual([
        ['sequence_paused', { enrollmentId: enrollment.id, sequence, reason: 'on a call' }],
        ['sequence_resumed', { enrollmentId: enrollment.id, sequence }],
      ]);
    });

    it('keeps a step that is not due yet at its planned time', async () => {
      const lead = await createLead({ status: 'contacted' });
      const planned = new Date(Date.now() + DAY);
      const enrollment = await enroll(lead.id, planned, 'paused');
      const resumed = await resumeEnrollment(db, enrollment.id);
      expect(resumed.job?.runAt).toBe(planned.getTime());
    });

    it('a reply or opt-out stops a paused enrollment, which then cannot be resumed', async () => {
      const lead = await createLead({ status: 'contacted' });
      const enrollment = await enroll(lead.id, new Date(), 'paused');
      expect(await db.$transaction((tx) => stopEnrollments(tx, lead.id, 'replied'))).toBe(1);
      expect(await resumeEnrollment(db, enrollment.id)).toEqual({
        status: 'conflict',
        current: 'stopped',
      });
    });

    it('returns not_found for an unknown enrollment', async () => {
      expect(await pauseEnrollment(db, randomUUID())).toEqual({ status: 'not_found' });
    });

    it('the service enqueues the step, and reports when it could not', async () => {
      const lead = await createLead({ status: 'contacted' });
      const queue = fakeQueue();
      const monitor = { stats: async () => [], retryFailed: async () => null };
      const service = createAdminService({ db, queue, monitor, thresholds, ...privacyDeps });

      const first = await enroll(lead.id, new Date(), 'paused');
      expect(await service.resumeEnrollment(first.id)).toMatchObject({
        status: 'resumed',
        queued: true,
      });
      expect(queue.enqueueFollowUpStep).toHaveBeenCalledWith(
        expect.objectContaining({ enrollmentId: first.id, step: 1 }),
      );

      const second = await enroll(lead.id, new Date(), 'paused');
      queue.enqueueFollowUpStep.mockRejectedValueOnce(new Error('redis down'));
      expect(await service.resumeEnrollment(second.id)).toMatchObject({
        status: 'resumed',
        queued: false,
      });
      // Still resumed in the database, so the reconcile sweep picks it up.
      expect((await db.enrollment.findUnique({ where: { id: second.id } }))?.status).toBe('active');
    });
  });

  describe('computeMetrics', () => {
    const T = new Date('2020-01-10T12:00:00Z');
    const at = (ms: number) => new Date(T.getTime() + ms);
    const range = { from: new Date('2020-01-01'), to: new Date('2020-02-01') };

    beforeAll(async () => {
      const firstContact = (leadId: string, ms: number, channel: 'email' | 'whatsapp' = 'email') =>
        addEvent(leadId, 'message_sent', at(ms), {
          channel,
          payload: { kind: 'first_contact' },
          dedupeKey: `first-contact:${leadId}:${channel}`,
        });
      const reply = (leadId: string, ms: number) =>
        addEvent(leadId, 'reply_received', at(ms), {
          channel: 'email',
          payload: { optOut: false },
        });

      // A: contacted after 60s, follow-up step 1 after 1h, replies after 2h (to the follow-up).
      const a = await createLead({ createdAt: T, tier: 'hot', status: 'converted' });
      const enrollment = await enroll(a.id, at(DAY));
      await firstContact(a.id, 60_000);
      await addEvent(a.id, 'message_sent', at(HOUR), {
        channel: 'email',
        payload: { kind: 'follow_up', enrollmentId: enrollment.id },
        dedupeKey: followUpKey(enrollment.id, 1),
      });
      await reply(a.id, 2 * HOUR);

      // B: contacted after 180s, replies after 10 min (to the first contact).
      const b = await createLead({ createdAt: T, tier: 'hot', status: 'engaged' });
      await firstContact(b.id, 180_000);
      await reply(b.id, 10 * MINUTE);

      // C: contacted after 120s on two channels (one touch); WhatsApp later fails; opts out.
      const c = await createLead({ createdAt: T, tier: 'warm', status: 'do_not_contact' });
      await firstContact(c.id, 120_000);
      await firstContact(c.id, 130_000, 'whatsapp');
      await addEvent(c.id, 'message_failed', at(5 * MINUTE), {
        channel: 'whatsapp',
        payload: { kind: 'first_contact', error: 'bad number', permanent: true },
      });
      await addEvent(c.id, 'opted_out', at(DAY), { payload: { source: 'unsubscribe_link' } });

      // D: disqualified; E: not scored yet. Neither is contacted.
      await createLead({ createdAt: T, tier: 'disqualified', status: 'disqualified' });
      await createLead({ createdAt: T });
      // Outside the range: ignored.
      await createLead({ createdAt: new Date('2020-02-15'), tier: 'hot' });
    });

    it('computes time to first contact, reply rate per touch, conversion and send failures', async () => {
      const m = await computeMetrics(db, { ...range, source });

      expect(m.timeToFirstContact.overall).toEqual({
        leads: 3,
        medianSeconds: 120,
        p90Seconds: 168,
        avgSeconds: 120,
      });
      expect(m.timeToFirstContact.byTier).toEqual({
        hot: { leads: 2, medianSeconds: 120, p90Seconds: 168, avgSeconds: 120 },
        warm: { leads: 1, medianSeconds: 120, p90Seconds: 120, avgSeconds: 120 },
      });

      expect(m.replyRateByStep).toEqual([
        {
          touch: 'first_contact',
          sequence: null,
          step: null,
          sent: 3,
          replied: 1,
          optedOut: 1,
          replyRate: 0.3333,
        },
        { touch: 'follow_up', sequence, step: 1, sent: 1, replied: 1, optedOut: 0, replyRate: 1 },
      ]);

      expect(m.conversion.overall).toEqual({
        leads: 5,
        contacted: 3,
        replied: 2,
        converted: 1,
        conversionRate: 0.2,
      });
      expect(m.conversion.bySource).toEqual([{ source, ...m.conversion.overall }]);
      const byTier = Object.fromEntries(m.conversion.byTier.map(({ tier, ...f }) => [tier, f]));
      expect(byTier).toEqual({
        hot: { leads: 2, contacted: 2, replied: 2, converted: 1, conversionRate: 0.5 },
        warm: { leads: 1, contacted: 1, replied: 0, converted: 0, conversionRate: 0 },
        disqualified: { leads: 1, contacted: 0, replied: 0, converted: 0, conversionRate: 0 },
        unscored: { leads: 1, contacted: 0, replied: 0, converted: 0, conversionRate: 0 },
      });

      expect(m.sends.byChannel).toEqual([
        {
          channel: 'email',
          kind: 'first_contact',
          sent: 3,
          failed: 0,
          permanentFailures: 0,
          failureRate: 0,
        },
        {
          channel: 'email',
          kind: 'follow_up',
          sent: 1,
          failed: 0,
          permanentFailures: 0,
          failureRate: 0,
        },
        {
          channel: 'whatsapp',
          kind: 'first_contact',
          sent: 1,
          failed: 1,
          permanentFailures: 1,
          failureRate: 0.5,
        },
      ]);
      expect(m.sends.topErrors).toEqual([
        { channel: 'whatsapp', error: 'bad number', count: 1, lastAt: at(5 * MINUTE) },
      ]);
    });

    it('returns empty metrics for a range with no leads', async () => {
      const m = await computeMetrics(db, {
        from: new Date('2019-01-01'),
        to: new Date('2019-01-02'),
        source,
      });
      expect(m.timeToFirstContact.overall).toEqual({
        leads: 0,
        medianSeconds: null,
        p90Seconds: null,
        avgSeconds: null,
      });
      expect(m.replyRateByStep).toEqual([]);
      expect(m.conversion.overall.leads).toBe(0);
      expect(m.sends.byChannel).toEqual([]);
    });
  });

  describe('evaluateAlerts', () => {
    it('reports recent send failures per channel and parked CRM syncs', async () => {
      const lead = await createLead({
        crmSyncFailedAt: new Date(),
        crmSyncError: 'HubSpot said no',
      });
      for (let i = 0; i < 2; i++) {
        await addEvent(lead.id, 'message_failed', new Date(), {
          channel: 'sms',
          payload: { kind: 'follow_up', error: `sms error ${i}` },
        });
      }
      // Outside the window: not counted.
      await addEvent(lead.id, 'message_failed', new Date(Date.now() - HOUR), {
        channel: 'sms',
        payload: { error: 'old' },
      });

      const alerts = await evaluateAlerts({ db, monitor: { stats: async () => [] }, thresholds });
      const keys = alerts.map((a) => a.key);
      expect(keys).toContain('send-failures:sms');
      expect(keys).toContain('crm-dead-letters');
      const sms = alerts.find((a) => a.key === 'send-failures:sms')!;
      expect(sms.details).toMatchObject({
        count: 2,
        lastError: expect.stringMatching(/^sms error/),
      });
    });
  });

  describe.skipIf(!redisUrl)('queues (Redis)', () => {
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const monitor = createQueueMonitor(redis);
    const token = 't'.repeat(32);

    afterAll(async () => {
      await monitor.close();
      redis.disconnect();
    });

    it('reports stats for every work queue and rejects unknown ones', async () => {
      const stats = await monitor.stats();
      expect(stats.map((s) => s.name)).toEqual(WORK_QUEUES);
      for (const s of stats) {
        expect(s).toEqual({
          name: s.name,
          waiting: expect.any(Number),
          active: expect.any(Number),
          delayed: expect.any(Number),
          failed: expect.any(Number),
          oldestWaitingMs: expect.any(Number),
        });
      }
      expect(await monitor.retryFailed('nope')).toBeNull();
      expect(await monitor.retryFailed('crm.sync.dead')).toBeNull();
    });

    it('serves the admin API and the Bull Board UI behind the token', async () => {
      const service = createAdminService({
        db,
        queue: fakeQueue(),
        monitor,
        thresholds,
        ...privacyDeps,
      });
      const app = await buildApp(
        testAppDeps({ admin: { token, service, boardQueues: monitor.queues } }),
      );
      try {
        const denied = await app.inject({ method: 'GET', url: '/admin/queues' });
        expect(denied.statusCode).toBe(401);

        const board = await app.inject({
          method: 'GET',
          url: '/admin/queues',
          headers: { authorization: `Basic ${btoa(`ops:${token}`)}` },
        });
        expect(board.statusCode).toBe(200);
        expect(board.headers['content-type']).toMatch(/text\/html/);
        expect(board.body).toContain('LeadFlow');

        const boardApi = await app.inject({
          method: 'GET',
          url: '/admin/queues/api/queues',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(boardApi.statusCode).toBe(200);
        const deniedApi = await app.inject({ method: 'GET', url: '/admin/queues/api/queues' });
        expect(deniedApi.statusCode).toBe(401);

        const stats = await app.inject({
          method: 'GET',
          url: '/admin/api/queues',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(stats.json().queues).toHaveLength(WORK_QUEUES.length);
      } finally {
        await app.close();
      }
    });
  });
});
