// Runs against the real Postgres (and Redis for the end-to-end cases): `npm run test:db`.
// Skipped when DATABASE_URL is not set, e.g. in CI.
import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createFormAdapters } from '../../src/capture/adapters/index.js';
import { createCaptureLead } from '../../src/capture/captureLead.js';
import type { MessageAdapters } from '../../src/contact/adapters/index.js';
import { PermanentSendError, type MessageAdapter } from '../../src/contact/adapters/types.js';
import { parseContactConfig } from '../../src/contact/config.js';
import {
  createPlanFirstContact,
  firstContactKey,
  repAlertKey,
} from '../../src/contact/planFirstContact.js';
import { createSendMessage, runSendMessageJob } from '../../src/contact/sendMessage.js';
import { createDb } from '../../src/db.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { createQualifyLead } from '../../src/qualification/qualifyLead.js';
import { loadScoringRules } from '../../src/qualification/rules.js';
import {
  LEAD_CAPTURED,
  LEAD_QUALIFIED,
  SEND_MESSAGE,
  createJobQueue,
  messageJobId,
  type LeadCapturedJob,
  type LeadQualifiedJob,
  type SendMessageJob,
} from '../../src/queue.js';
import { fakeQueue, testAppDeps } from '../helpers.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];

// 12:00 in São Paulo, outside quiet hours.
const noonInSaoPaulo = () => new Date('2026-09-23T12:00:00-03:00');
const HOUR = 60 * 60 * 1000;

describe.skipIf(!databaseUrl)('first contact (database)', () => {
  const db = createDb(databaseUrl!);
  const leadIds = new Set<string>();
  const suffix = randomUUID().slice(0, 8);
  const names = {
    whatsapp: `test_wa_${suffix}`,
    email: `test_email_${suffix}`,
    alert: `test_alert_${suffix}`,
  };

  const contactConfig = parseContactConfig({
    quietHours: {
      start: '21:00',
      end: '08:00',
      channels: ['whatsapp'],
      defaultTimezone: 'America/Sao_Paulo',
    },
    tiers: {
      hot: {
        messages: [
          { channel: 'whatsapp', template: names.whatsapp },
          { channel: 'email', template: names.email },
        ],
        repAlertTemplate: names.alert,
      },
      warm: { messages: [{ channel: 'email', template: names.email }] },
      cold: { messages: [{ channel: 'email', template: names.email }] },
    },
    replies: { optOutKeywords: ['STOP'] },
  });

  beforeAll(async () => {
    await db.template.createMany({
      data: [
        {
          name: names.whatsapp,
          channel: 'whatsapp',
          locale: 'en_US',
          body: 'Hi {{firstName|there}}',
        },
        { name: names.email, channel: 'email', subject: 'Hi {{firstName|there}}', body: 'Hello' },
        { name: names.alert, channel: 'email', subject: 'Hot: {{email}}', body: 'Score {{score}}' },
      ],
    });
  });

  afterAll(async () => {
    await db.lead.deleteMany({ where: { id: { in: [...leadIds] } } });
    await db.template.deleteMany({ where: { name: { in: Object.values(names) } } });
    await db.$disconnect();
  });

  function fakeAdapter(impl?: MessageAdapter['send']) {
    return {
      provider: 'fake',
      send: vi.fn<MessageAdapter['send']>(impl ?? (async () => ({ externalId: randomUUID() }))),
    };
  }

  function adapters(): {
    email: ReturnType<typeof fakeAdapter>;
    whatsapp: ReturnType<typeof fakeAdapter>;
  } {
    return { email: fakeAdapter(), whatsapp: fakeAdapter() };
  }

  async function createLead(data: Partial<Prisma.LeadCreateInput> = {}) {
    const lead = await db.lead.create({
      data: {
        source: 'test',
        rawPayload: {},
        firstName: 'Ana',
        email: `lead-${randomUUID()}@example.com`,
        phone: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        consentEmail: true,
        consentMessaging: true,
        status: 'qualified',
        tier: 'hot',
        score: 80,
        ...data,
      },
    });
    leadIds.add(lead.id);
    return lead;
  }

  const qualifiedJob = (leadId: string): LeadQualifiedJob => ({
    leadId,
    eventId: randomUUID(),
    score: 80,
    tier: 'hot',
  });

  describe('planFirstContact', () => {
    function plan(
      opts: { now?: () => Date; salesAlertEmail?: string; adapters?: MessageAdapters } = {},
    ) {
      const queue = fakeQueue();
      const run = createPlanFirstContact({
        db,
        queue,
        config: contactConfig,
        adapters: opts.adapters ?? adapters(),
        salesAlertEmail: 'salesAlertEmail' in opts ? opts.salesAlertEmail : 'sales@example.com',
        now: opts.now ?? noonInSaoPaulo,
      });
      return { queue, run };
    }

    it('schedules WhatsApp, email and a rep alert for a hot lead', async () => {
      const lead = await createLead();
      const { queue, run } = plan();

      const result = await run(qualifiedJob(lead.id));

      expect(result?.skipped).toEqual([]);
      expect(queue.enqueueSendMessage.mock.calls).toEqual([
        [
          {
            leadId: lead.id,
            kind: 'first_contact',
            channel: 'whatsapp',
            template: names.whatsapp,
            dedupeKey: firstContactKey(lead.id, 'whatsapp'),
          },
          { delayMs: 0 },
        ],
        [
          {
            leadId: lead.id,
            kind: 'first_contact',
            channel: 'email',
            template: names.email,
            dedupeKey: firstContactKey(lead.id, 'email'),
          },
          { delayMs: 0 },
        ],
        [
          {
            leadId: lead.id,
            kind: 'rep_alert',
            channel: 'email',
            template: names.alert,
            to: 'sales@example.com',
            dedupeKey: repAlertKey(lead.id),
          },
        ],
      ]);
    });

    it("delays WhatsApp until quiet hours end in the lead's time zone, but not email", async () => {
      const lead = await createLead({ timezone: 'America/Sao_Paulo' });
      const { run } = plan({ now: () => new Date('2026-09-23T23:00:00-03:00') });

      const result = await run(qualifiedJob(lead.id));

      expect(result?.scheduled).toMatchObject([
        { channel: 'whatsapp', delayMs: 9 * HOUR },
        { channel: 'email', delayMs: 0 },
        { kind: 'rep_alert', delayMs: 0 },
      ]);
    });

    it('skips channels without consent, address or provider', async () => {
      const noConsent = await createLead({ consentMessaging: false });
      expect((await plan().run(qualifiedJob(noConsent.id)))?.skipped).toEqual([
        { kind: 'first_contact', channel: 'whatsapp', reason: 'no messaging consent' },
      ]);

      const noEmail = await createLead({ email: null });
      expect((await plan().run(qualifiedJob(noEmail.id)))?.skipped).toEqual([
        { kind: 'first_contact', channel: 'email', reason: 'no email' },
      ]);

      const lead = await createLead();
      const emailOnly = { email: fakeAdapter() };
      expect((await plan({ adapters: emailOnly }).run(qualifiedJob(lead.id)))?.skipped).toEqual([
        { kind: 'first_contact', channel: 'whatsapp', reason: 'no provider for whatsapp' },
      ]);
    });

    it('skips the rep alert when SALES_ALERT_EMAIL is not set', async () => {
      const lead = await createLead();
      const result = await plan({ salesAlertEmail: undefined }).run(qualifiedJob(lead.id));
      expect(result?.skipped).toEqual([
        { kind: 'rep_alert', channel: 'email', reason: 'SALES_ALERT_EMAIL not set' },
      ]);
    });

    it.each(['engaged', 'do_not_contact', 'disqualified', 'new'] as const)(
      'contacts nobody when the lead is %s',
      async (status) => {
        const lead = await createLead({ status });
        const { queue, run } = plan();
        const result = await run(qualifiedJob(lead.id));
        expect(result?.scheduled).toEqual([]);
        expect(queue.enqueueSendMessage).not.toHaveBeenCalled();
      },
    );

    it('only adds channels not contacted yet when a lead is re-qualified to a higher tier', async () => {
      const lead = await createLead({ tier: 'cold', status: 'contacted' });
      await db.leadEvent.create({
        data: {
          leadId: lead.id,
          type: 'message_sent',
          channel: 'email',
          dedupeKey: firstContactKey(lead.id, 'email'),
        },
      });
      await db.lead.update({ where: { id: lead.id }, data: { tier: 'hot' } });

      const result = await plan().run(qualifiedJob(lead.id));

      expect(result?.scheduled.map((s) => [s.kind, s.channel])).toEqual([
        ['first_contact', 'whatsapp'],
        ['rep_alert', 'email'],
      ]);
      expect(result?.skipped).toEqual([
        { kind: 'first_contact', channel: 'email', reason: 'already sent' },
      ]);
    });

    it('uses the current tier rather than the one in the job', async () => {
      const lead = await createLead({ tier: 'disqualified', status: 'disqualified' });
      const result = await plan().run(qualifiedJob(lead.id));
      expect(result?.scheduled).toEqual([]);
    });
  });

  describe('sendMessage', () => {
    const job = (leadId: string, overrides: Partial<SendMessageJob> = {}): SendMessageJob => ({
      leadId,
      kind: 'first_contact',
      channel: 'email',
      template: names.email,
      dedupeKey: firstContactKey(leadId, 'email'),
      ...overrides,
    });
    const events = (leadId: string) =>
      db.leadEvent.findMany({ where: { leadId }, orderBy: { createdAt: 'asc' } });

    it('sends, records message_sent and marks the lead contacted, once', async () => {
      const lead = await createLead();
      const a = adapters();
      a.email.send.mockResolvedValue({ externalId: 'provider-1' });
      const send = createSendMessage({ db, adapters: a, queue: fakeQueue() });

      const outcome = await send(job(lead.id), { final: false });

      expect(outcome).toMatchObject({ status: 'sent', externalId: 'provider-1', provider: 'fake' });
      expect(a.email.send).toHaveBeenCalledWith({
        to: lead.email,
        template: expect.objectContaining({ name: names.email }),
        vars: expect.objectContaining({ firstName: 'Ana' }),
        idempotencyKey: firstContactKey(lead.id, 'email'),
      });
      expect(await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
        status: 'contacted',
      });
      expect(await events(lead.id)).toMatchObject([
        {
          type: 'message_sent',
          channel: 'email',
          dedupeKey: firstContactKey(lead.id, 'email'),
          payload: {
            kind: 'first_contact',
            template: names.email,
            to: lead.email,
            provider: 'fake',
            externalId: 'provider-1',
          },
        },
      ]);

      expect(await send(job(lead.id), { final: false })).toEqual({ status: 'duplicate' });
      expect(a.email.send).toHaveBeenCalledOnce();
    });

    it('records a rep alert as rep_notified without changing the lead status', async () => {
      const lead = await createLead();
      const a = adapters();
      const send = createSendMessage({ db, adapters: a, queue: fakeQueue() });

      await send(
        job(lead.id, {
          kind: 'rep_alert',
          template: names.alert,
          to: 'sales@example.com',
          dedupeKey: repAlertKey(lead.id),
        }),
        { final: false },
      );

      expect(a.email.send.mock.calls[0]![0].to).toBe('sales@example.com');
      expect(await events(lead.id)).toMatchObject([{ type: 'rep_notified', channel: 'email' }]);
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
        'qualified',
      );
    });

    it('re-checks eligibility at send time', async () => {
      const lead = await createLead();
      await db.lead.update({ where: { id: lead.id }, data: { status: 'do_not_contact' } });
      const a = adapters();

      const outcome = await createSendMessage({ db, adapters: a, queue: fakeQueue() })(
        job(lead.id),
        { final: false },
      );

      expect(outcome).toEqual({ status: 'skipped', reason: 'status is do_not_contact' });
      expect(a.email.send).not.toHaveBeenCalled();
      expect(await events(lead.id)).toEqual([]);
    });

    it('records message_failed only on the last attempt of a retryable failure', async () => {
      const lead = await createLead();
      const a = adapters();
      a.email.send.mockRejectedValue(new Error('resend responded 503'));
      const send = createSendMessage({ db, adapters: a, queue: fakeQueue() });

      await expect(send(job(lead.id), { final: false })).rejects.toThrow('503');
      expect(await events(lead.id)).toEqual([]);

      await expect(send(job(lead.id), { final: true })).rejects.toThrow('503');
      await expect(send(job(lead.id), { final: true })).rejects.toThrow('503');
      expect(await events(lead.id)).toMatchObject([
        {
          type: 'message_failed',
          dedupeKey: `${firstContactKey(lead.id, 'email')}:failed`,
          payload: { kind: 'first_contact', error: 'resend responded 503', permanent: false },
        },
      ]);
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
        'qualified',
      );
    });

    it('records a permanent failure right away', async () => {
      const lead = await createLead();
      const send = createSendMessage({ db, adapters: adapters(), queue: fakeQueue() });

      await expect(
        send(job(lead.id, { template: 'no_such_template' }), { final: false }),
      ).rejects.toThrow(PermanentSendError);
      expect(await events(lead.id)).toMatchObject([
        { type: 'message_failed', payload: { permanent: true } },
      ]);
    });

    it('turns permanent failures into unrecoverable job errors', async () => {
      const lead = await createLead();
      const send = createSendMessage({ db, adapters: adapters(), queue: fakeQueue() });
      const err = await runSendMessageJob(send, {
        data: job(lead.id, { template: 'no_such_template' }),
        attemptsMade: 0,
        opts: { attempts: 5 },
      }).catch((e: unknown) => e);
      expect((err as Error).name).toBe('UnrecoverableError');
    });
  });

  describe.skipIf(!redisUrl)('end to end with Redis (dry-run style adapters)', () => {
    it('a hot webhook lead gets WhatsApp and email within seconds, plus a rep alert', async () => {
      const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      const queue = createJobQueue(redis);
      const workerConnection = redis.duplicate();
      const a = adapters();
      const qualify = createQualifyLead(db, queue, loadScoringRules('config/scoring.json'));
      const planContact = createPlanFirstContact({
        db,
        queue,
        config: contactConfig,
        adapters: a,
        salesAlertEmail: 'sales@example.com',
        now: noonInSaoPaulo,
      });
      const send = createSendMessage({ db, adapters: a, queue: fakeQueue() });
      const workers = [
        new Worker<LeadCapturedJob>(LEAD_CAPTURED, (job) => qualify(job.data), {
          connection: workerConnection,
        }),
        new Worker<LeadQualifiedJob>(LEAD_QUALIFIED, (job) => planContact(job.data), {
          connection: workerConnection,
        }),
        new Worker<SendMessageJob>(SEND_MESSAGE, (job) => runSendMessageJob(send, job), {
          connection: workerConnection,
        }),
      ];
      const app = await buildApp(
        testAppDeps({
          formAdapters: createFormAdapters({
            DEFAULT_PHONE_COUNTRY: 'BR',
            FORM_WEBHOOK_SECRET: 'e2e-secret',
            TYPEFORM_WEBHOOK_SECRET: undefined,
          }),
          captureLead: createCaptureLead(db, queue),
        }),
      );

      try {
        const started = Date.now();
        const res = await app.inject({
          method: 'POST',
          url: '/webhooks/forms/website',
          headers: { 'x-webhook-secret': 'e2e-secret' },
          payload: {
            name: 'Carla Mendes',
            email: `carla-${randomUUID()}@mendes-engenharia.com.br`,
            phone: `(31) 9${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
            company: 'Mendes Engenharia',
            consentEmail: true,
            consentMessaging: true,
            fields: { budget: 50000 },
          },
        });
        const { leadId } = res.json();
        leadIds.add(leadId);

        await vi.waitFor(
          async () => {
            const sent = await db.leadEvent.count({
              where: { leadId, type: { in: ['message_sent', 'rep_notified'] } },
            });
            expect(sent).toBe(3);
          },
          { timeout: 10_000, interval: 100 },
        );

        const types = (
          await db.leadEvent.findMany({ where: { leadId }, orderBy: { createdAt: 'asc' } })
        ).map((e) => [e.type, e.channel]);
        expect(types.slice(0, 2)).toEqual([
          ['captured', null],
          ['scored', null],
        ]);
        expect(types.slice(2)).toEqual(
          expect.arrayContaining([
            ['message_sent', 'whatsapp'],
            ['message_sent', 'email'],
            ['rep_notified', 'email'],
          ]),
        );
        expect(await db.lead.findUniqueOrThrow({ where: { id: leadId } })).toMatchObject({
          tier: 'hot',
          status: 'contacted',
        });
        expect(Date.now() - started).toBeLessThan(60_000);
      } finally {
        await app.close();
        await Promise.all(workers.map((w) => w.close()));
        await queue.close();
        redis.disconnect();
        workerConnection.disconnect();
      }
    });

    it('retries a failing send with BullMQ and records message_failed after the last attempt', async () => {
      const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      const workerConnection = redis.duplicate();
      const eventsConnection = redis.duplicate();
      const sendQueue = new Queue<SendMessageJob>(SEND_MESSAGE, { connection: redis });
      const events = new QueueEvents(SEND_MESSAGE, { connection: eventsConnection });
      const a = adapters();
      // Records how many failures were already logged when each attempt starts.
      const failuresSeen: number[] = [];
      a.email.send.mockImplementation(async (req) => {
        failuresSeen.push(
          await db.leadEvent.count({
            where: { dedupeKey: `${req.idempotencyKey}:failed` },
          }),
        );
        throw new Error('resend responded 503');
      });
      const send = createSendMessage({ db, adapters: a, queue: fakeQueue() });
      const worker = new Worker<SendMessageJob>(
        SEND_MESSAGE,
        (job) => runSendMessageJob(send, job),
        {
          connection: workerConnection,
        },
      );

      try {
        await events.waitUntilReady();
        const lead = await createLead();
        const dedupeKey = firstContactKey(lead.id, 'email');
        const job = await sendQueue.add(
          SEND_MESSAGE,
          {
            leadId: lead.id,
            kind: 'first_contact',
            channel: 'email',
            template: names.email,
            dedupeKey,
          },
          { jobId: messageJobId(dedupeKey), attempts: 3, backoff: { type: 'fixed', delay: 10 } },
        );

        await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow('503');

        expect(a.email.send).toHaveBeenCalledTimes(3);
        // Nothing recorded before the last attempt: BullMQ's attemptsMade is read correctly.
        expect(failuresSeen).toEqual([0, 0, 0]);
        const failed = await db.leadEvent.findMany({ where: { leadId: lead.id } });
        expect(failed).toMatchObject([{ type: 'message_failed', payload: { permanent: false } }]);
        await job.remove();
      } finally {
        await worker.close();
        await events.close();
        await sendQueue.close();
        [redis, workerConnection, eventsConnection].forEach((c) => c.disconnect());
      }
    });
  });
});
