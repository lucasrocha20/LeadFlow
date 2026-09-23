// Runs against the real Postgres (and Redis for the end-to-end cases): `npm run test:db`.
// Skipped when DATABASE_URL is not set, e.g. in CI.
import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { MessageAdapter } from '../../src/contact/adapters/types.js';
import { firstContactKey } from '../../src/contact/planFirstContact.js';
import { createSendMessage, runSendMessageJob } from '../../src/contact/sendMessage.js';
import { createDb } from '../../src/db.js';
import { followUpKey, reconcileEnrollments } from '../../src/followup/enrollment.js';
import { createRunFollowUpStep } from '../../src/followup/runStep.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { createReplyAdapters } from '../../src/inbound/adapters/index.js';
import { whatsappSignature } from '../../src/inbound/adapters/whatsapp.js';
import { createHandleInbound } from '../../src/inbound/handleInbound.js';
import { createOptOut } from '../../src/inbound/optOut.js';
import type { InboundMessage } from '../../src/inbound/types.js';
import {
  FOLLOW_UP_STEP,
  SEND_MESSAGE,
  createJobQueue,
  type FollowUpStepJob,
  type SendMessageJob,
} from '../../src/queue.js';
import { fakeQueue, testAppDeps } from '../helpers.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 12:00 in São Paulo: outside quiet hours.
const T0 = new Date('2026-09-23T12:00:00-03:00').getTime();
const quietHours = {
  start: '21:00',
  end: '08:00',
  channels: ['whatsapp' as const],
  defaultTimezone: 'America/Sao_Paulo',
};

describe.skipIf(!databaseUrl)('follow-up (database)', () => {
  const db = createDb(databaseUrl!);
  const leadIds = new Set<string>();
  const suffix = randomUUID().slice(0, 8);
  const names = {
    firstEmail: `t_first_${suffix}`,
    followWa: `t_follow_wa_${suffix}`,
    followEmail: `t_follow_email_${suffix}`,
    lastEmail: `t_last_${suffix}`,
    replyAlert: `t_reply_alert_${suffix}`,
    // hot: +1h WhatsApp, +1d email, +3d email, then 3 more days to reply.
    sequence: `t_hot_${suffix}`,
    // Everything immediately, for the end-to-end run.
    instant: `t_instant_${suffix}`,
  };
  const sequences = { hot: names.sequence, warm: names.instant };

  beforeAll(async () => {
    await db.template.createMany({
      data: [
        {
          name: names.firstEmail,
          channel: 'email',
          subject: 'Hi',
          body: 'Hello {{firstName|there}}',
        },
        { name: names.followWa, channel: 'whatsapp', locale: 'en_US', body: 'Any news?' },
        {
          name: names.followEmail,
          channel: 'email',
          subject: 'Following up',
          body: 'Unsubscribe: {{unsubscribeUrl|reply STOP}}',
        },
        { name: names.lastEmail, channel: 'email', subject: 'Last try', body: 'Bye' },
        {
          name: names.replyAlert,
          channel: 'email',
          subject: '{{fullName}} replied',
          body: '{{replyChannel}}: {{replyText}}',
        },
      ],
    });
    const step = (
      order: number,
      offsetMinutes: number,
      channel: 'email' | 'whatsapp',
      template: string,
    ) => ({
      order,
      offsetMinutes,
      channel,
      template: { connect: { name: template } },
    });
    await db.sequence.create({
      data: {
        name: names.sequence,
        tier: 'hot',
        finalWaitMinutes: 3 * 24 * 60,
        steps: {
          create: [
            step(1, 60, 'whatsapp', names.followWa),
            step(2, 24 * 60, 'email', names.followEmail),
            step(3, 3 * 24 * 60, 'email', names.lastEmail),
          ],
        },
      },
    });
    await db.sequence.create({
      data: {
        name: names.instant,
        tier: 'warm',
        finalWaitMinutes: 0,
        steps: {
          create: [
            step(1, 0, 'whatsapp', names.followWa),
            step(2, 0, 'email', names.followEmail),
            step(3, 0, 'email', names.lastEmail),
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await db.lead.deleteMany({ where: { id: { in: [...leadIds] } } });
    await db.sequence.deleteMany({ where: { name: { in: [names.sequence, names.instant] } } });
    await db.template.deleteMany({ where: { name: { startsWith: 't_', endsWith: suffix } } });
    await db.$disconnect();
  });

  function fakeAdapter() {
    return {
      provider: 'fake',
      send: vi.fn<MessageAdapter['send']>(async () => ({ externalId: randomUUID() })),
    };
  }

  const uniquePhone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

  async function createLead(data: Partial<Prisma.LeadCreateInput> = {}) {
    const lead = await db.lead.create({
      data: {
        source: 'test',
        rawPayload: {},
        firstName: 'Ana',
        lastName: 'Souza',
        email: `lead-${randomUUID()}@example.com`,
        phone: uniquePhone(),
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

  /** Sends the first contact through sendMessage, which enrolls the lead. */
  async function firstContact(leadId: string, at = T0) {
    const queue = fakeQueue();
    const send = createSendMessage({
      db,
      adapters: { email: fakeAdapter(), whatsapp: fakeAdapter() },
      queue,
      followUpSequences: sequences,
      now: () => new Date(at),
    });
    const outcome = await send(
      {
        leadId,
        kind: 'first_contact',
        channel: 'email',
        template: names.firstEmail,
        dedupeKey: firstContactKey(leadId, 'email'),
      },
      { final: false },
    );
    return { outcome, queue };
  }

  function stepRunner(at: () => number) {
    const queue = fakeQueue();
    const run = createRunFollowUpStep({ db, queue, quietHours, now: () => new Date(at()) });
    return { queue, run };
  }

  const events = (leadId: string) =>
    db.leadEvent.findMany({ where: { leadId }, orderBy: { createdAt: 'asc' } });
  const enrollmentOf = (leadId: string) => db.enrollment.findFirstOrThrow({ where: { leadId } });

  describe('enrollment', () => {
    it('enrolls the lead on its first contact and schedules the first step', async () => {
      const lead = await createLead();
      const { outcome, queue } = await firstContact(lead.id);

      const enrollment = await enrollmentOf(lead.id);
      expect(enrollment).toMatchObject({
        status: 'active',
        currentStep: 1,
        nextRunAt: new Date(T0 + HOUR),
      });
      expect(outcome).toMatchObject({ status: 'sent', enrolled: { step: 1, runAt: T0 + HOUR } });
      expect(queue.enqueueFollowUpStep).toHaveBeenCalledExactlyOnceWith({
        enrollmentId: enrollment.id,
        step: 1,
        runAt: T0 + HOUR,
      });
      expect((await events(lead.id)).map((e) => e.type)).toEqual(['enrolled', 'message_sent']);
    });

    it('enrolls once even when several first-contact channels go out', async () => {
      const lead = await createLead();
      await firstContact(lead.id);
      const queue = fakeQueue();
      await createSendMessage({
        db,
        adapters: { whatsapp: fakeAdapter() },
        queue,
        followUpSequences: sequences,
      })(
        {
          leadId: lead.id,
          kind: 'first_contact',
          channel: 'whatsapp',
          template: names.followWa,
          dedupeKey: firstContactKey(lead.id, 'whatsapp'),
        },
        { final: false },
      );
      expect(await db.enrollment.count({ where: { leadId: lead.id } })).toBe(1);
      expect(queue.enqueueFollowUpStep).not.toHaveBeenCalled();
    });

    it('does not enroll when the tier has no sequence', async () => {
      const lead = await createLead({ tier: 'cold' });
      const { outcome } = await firstContact(lead.id);
      expect(outcome).toMatchObject({ status: 'sent' });
      expect(outcome).not.toHaveProperty('enrolled');
      expect(await db.enrollment.count({ where: { leadId: lead.id } })).toBe(0);
    });
  });

  describe('runFollowUpStep', () => {
    it('a lead that never replies gets every step on time, then becomes unresponsive', async () => {
      const lead = await createLead();
      const { queue: firstQueue } = await firstContact(lead.id);
      let job: FollowUpStepJob = firstQueue.enqueueFollowUpStep.mock.calls[0]![0];
      let clock = 0;
      const { queue, run } = stepRunner(() => clock);

      // Run each step exactly when its job is due, as BullMQ would.
      const due: number[] = [];
      for (let i = 0; i < 3; i++) {
        clock = job.runAt;
        due.push(clock - T0);
        expect(await run(job)).toMatchObject({ status: 'queued', step: i + 1 });
        job = queue.enqueueFollowUpStep.mock.calls[i]![0];
      }
      expect(due).toEqual([HOUR, DAY, 3 * DAY]);

      expect(queue.enqueueSendMessage.mock.calls).toEqual([
        [
          {
            leadId: lead.id,
            kind: 'follow_up',
            channel: 'whatsapp',
            template: names.followWa,
            dedupeKey: followUpKey(job.enrollmentId, 1),
            enrollmentId: job.enrollmentId,
          },
          { delayMs: 0 },
        ],
        [
          expect.objectContaining({ channel: 'email', template: names.followEmail }),
          { delayMs: 0 },
        ],
        [expect.objectContaining({ channel: 'email', template: names.lastEmail }), { delayMs: 0 }],
      ]);

      // After the last step, the completion check runs once the final wait is over.
      expect(job.runAt).toBe(T0 + 6 * DAY);
      clock = job.runAt;
      expect(await run(job)).toEqual({ status: 'completed' });

      expect(await enrollmentOf(lead.id)).toMatchObject({ status: 'completed', nextRunAt: null });
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
        'unresponsive',
      );
      expect((await events(lead.id)).at(-1)).toMatchObject({ type: 'sequence_completed' });
    });

    it('delays WhatsApp follow-ups past quiet hours without shifting the schedule', async () => {
      const lead = await createLead({ timezone: 'America/Sao_Paulo' });
      // First contact at 20:30, so the +1h WhatsApp step falls at 21:30 (quiet until 08:00).
      const at = new Date('2026-09-23T20:30:00-03:00').getTime();
      const { queue: firstQueue } = await firstContact(lead.id, at);
      const job = firstQueue.enqueueFollowUpStep.mock.calls[0]![0];
      const { queue, run } = stepRunner(() => job.runAt);

      await run(job);

      expect(queue.enqueueSendMessage.mock.calls[0]![1]).toEqual({ delayMs: 10.5 * HOUR });
      expect(queue.enqueueFollowUpStep.mock.calls[0]![0].runAt).toBe(at + DAY);
    });

    it('keeps the planned gap after downtime instead of sending overdue steps back to back', async () => {
      const lead = await createLead();
      const { queue: firstQueue } = await firstContact(lead.id);
      const job = firstQueue.enqueueFollowUpStep.mock.calls[0]![0];
      const late = T0 + 5 * DAY; // every step is overdue
      const { queue, run } = stepRunner(() => late);

      await run(job);

      // Step 2 was planned 23h after step 1.
      expect(queue.enqueueFollowUpStep.mock.calls[0]![0].runAt).toBe(late + 23 * HOUR);
    });

    it('skips jobs that are early, stale or for inactive enrollments', async () => {
      const lead = await createLead();
      const { queue: firstQueue } = await firstContact(lead.id);
      const job = firstQueue.enqueueFollowUpStep.mock.calls[0]![0];

      expect(await stepRunner(() => T0).run(job)).toEqual({
        status: 'skipped',
        reason: 'not due yet',
      });
      expect(await stepRunner(() => job.runAt).run({ ...job, step: 2 })).toEqual({
        status: 'skipped',
        reason: 'stale job',
      });
      await db.enrollment.update({ where: { id: job.enrollmentId }, data: { status: 'stopped' } });
      expect(await stepRunner(() => job.runAt).run(job)).toEqual({
        status: 'skipped',
        reason: 'enrollment is stopped',
      });
    });

    it('re-queues the same message and next step when retried after advancing', async () => {
      const lead = await createLead();
      const { queue: firstQueue } = await firstContact(lead.id);
      const job = firstQueue.enqueueFollowUpStep.mock.calls[0]![0];
      const { queue, run } = stepRunner(() => job.runAt);

      await run(job);
      await run(job); // e.g. the first attempt failed to enqueue after committing

      const [first, retry] = queue.enqueueSendMessage.mock.calls;
      expect(retry).toEqual(first);
      const [next, nextRetry] = queue.enqueueFollowUpStep.mock.calls;
      expect(nextRetry).toEqual(next);
      expect((await enrollmentOf(lead.id)).currentStep).toBe(2);
    });

    it('stops the sequence when the lead is no longer contactable', async () => {
      const lead = await createLead();
      const { queue: firstQueue } = await firstContact(lead.id);
      const job = firstQueue.enqueueFollowUpStep.mock.calls[0]![0];
      await db.lead.update({ where: { id: lead.id }, data: { status: 'converted' } });
      const { queue, run } = stepRunner(() => job.runAt);

      expect(await run(job)).toEqual({ status: 'stopped', reason: 'lead is converted' });
      expect(queue.enqueueSendMessage).not.toHaveBeenCalled();
      expect(await enrollmentOf(lead.id)).toMatchObject({ status: 'stopped' });
      expect((await events(lead.id)).at(-1)).toMatchObject({
        type: 'sequence_stopped',
        payload: { reason: 'lead is converted' },
      });
    });
  });

  describe('sending follow-ups', () => {
    it('adds an unsubscribe link and drops the message once the enrollment stops', async () => {
      const lead = await createLead();
      const { queue: firstQueue } = await firstContact(lead.id);
      const { enrollmentId } = firstQueue.enqueueFollowUpStep.mock.calls[0]![0];
      const email = fakeAdapter();
      const send = createSendMessage({
        db,
        adapters: { email },
        queue: fakeQueue(),
        unsubscribeUrl: (id) => `https://leads.example.com/unsubscribe?lead=${id}`,
      });
      const job: SendMessageJob = {
        leadId: lead.id,
        kind: 'follow_up',
        channel: 'email',
        template: names.followEmail,
        dedupeKey: followUpKey(enrollmentId, 2),
        enrollmentId,
      };

      expect(await send(job, { final: false })).toMatchObject({ status: 'sent' });
      expect(email.send.mock.calls[0]![0].vars['unsubscribeUrl']).toBe(
        `https://leads.example.com/unsubscribe?lead=${lead.id}`,
      );

      await db.enrollment.update({ where: { id: enrollmentId }, data: { status: 'stopped' } });
      expect(
        await send({ ...job, dedupeKey: followUpKey(enrollmentId, 3) }, { final: false }),
      ).toEqual({ status: 'skipped', reason: 'enrollment is stopped' });
    });

    it('never puts the unsubscribe link in rep alerts', async () => {
      const lead = await createLead();
      const email = fakeAdapter();
      await createSendMessage({
        db,
        adapters: { email },
        queue: fakeQueue(),
        unsubscribeUrl: () => 'https://leads.example.com/unsubscribe',
      })(
        {
          leadId: lead.id,
          kind: 'rep_alert',
          channel: 'email',
          template: names.replyAlert,
          to: 'sales@example.com',
          dedupeKey: `rep-reply:${randomUUID()}`,
          vars: { replyChannel: 'email', replyText: 'hi' },
        },
        { final: false },
      );
      expect(email.send.mock.calls[0]![0].vars).not.toHaveProperty('unsubscribeUrl');
      expect(email.send.mock.calls[0]![0].vars).toMatchObject({ replyText: 'hi' });
    });
  });

  describe('replies and opt-outs', () => {
    function inbound(opts: { salesAlertEmail?: string } = {}) {
      const queue = fakeQueue();
      const handle = createHandleInbound({
        db,
        queue,
        optOutKeywords: ['STOP', 'SAIR'],
        salesAlertEmail: 'salesAlertEmail' in opts ? opts.salesAlertEmail : 'sales@example.com',
        repAlertTemplate: names.replyAlert,
      });
      return { queue, handle };
    }

    const whatsappReply = (from: string, text: string): InboundMessage => ({
      channel: 'whatsapp',
      externalId: `wamid.${randomUUID()}`,
      from,
      text,
      receivedAt: new Date(),
    });

    it('a lead that replies gets nothing further, and the rep is told', async () => {
      const lead = await createLead();
      const { queue: firstQueue } = await firstContact(lead.id);
      const job = firstQueue.enqueueFollowUpStep.mock.calls[0]![0];
      const { queue, handle } = inbound();

      const reply = whatsappReply(lead.phone!, 'Yes! Can you call me tomorrow?');
      expect(await handle(reply)).toEqual({
        status: 'replied',
        leadId: lead.id,
        engaged: true,
        stoppedSequences: 1,
      });

      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('engaged');
      expect(await enrollmentOf(lead.id)).toMatchObject({ status: 'stopped', nextRunAt: null });
      const all = await events(lead.id);
      expect(all.slice(-2)).toMatchObject([
        {
          type: 'reply_received',
          channel: 'whatsapp',
          payload: { text: reply.text, engaged: true },
        },
        { type: 'sequence_stopped', payload: { reason: 'replied' } },
      ]);
      const replyEvent = all.at(-2)!;
      expect(queue.enqueueSendMessage).toHaveBeenCalledExactlyOnceWith({
        leadId: lead.id,
        kind: 'rep_alert',
        channel: 'email',
        template: names.replyAlert,
        to: 'sales@example.com',
        dedupeKey: `rep-reply:${replyEvent.id}`,
        vars: { replyChannel: 'whatsapp', replyText: reply.text },
      });

      // The step that was due next does nothing.
      const { queue: stepQueue, run } = stepRunner(() => job.runAt);
      expect(await run(job)).toEqual({ status: 'skipped', reason: 'enrollment is stopped' });
      expect(stepQueue.enqueueSendMessage).not.toHaveBeenCalled();

      // A replayed webhook changes nothing but re-queues the (deduplicated) alert.
      expect(await handle(reply)).toEqual({ status: 'duplicate' });
      expect(queue.enqueueSendMessage.mock.calls[1]).toEqual(
        queue.enqueueSendMessage.mock.calls[0],
      );
      expect(await db.leadEvent.count({ where: { leadId: lead.id, type: 'reply_received' } })).toBe(
        1,
      );
    });

    it('matches email replies by address and only alerts on the first engagement', async () => {
      const lead = await createLead();
      await firstContact(lead.id);
      const { queue, handle } = inbound();
      const emailReply = (text: string): InboundMessage => ({
        channel: 'email',
        externalId: `<${randomUUID()}@mail>`,
        from: lead.email!,
        text,
        subject: 'Re: Hi',
        receivedAt: new Date(),
      });

      expect(await handle(emailReply('Interested'))).toMatchObject({ engaged: true });
      expect(await handle(emailReply('Also, pricing?'))).toMatchObject({
        engaged: false,
        stoppedSequences: 0,
      });
      expect(queue.enqueueSendMessage).toHaveBeenCalledOnce();
    });

    it('opts the lead out on STOP, without alerting the rep', async () => {
      const lead = await createLead();
      await firstContact(lead.id);
      const { queue, handle } = inbound();

      expect(await handle(whatsappReply(lead.phone!, 'Sair'))).toEqual({
        status: 'opted_out',
        leadId: lead.id,
      });

      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
        'do_not_contact',
      );
      expect(await enrollmentOf(lead.id)).toMatchObject({ status: 'stopped' });
      expect((await events(lead.id)).slice(-3)).toMatchObject([
        { type: 'reply_received', payload: { optOut: true } },
        { type: 'opted_out', payload: { source: 'reply', previousStatus: 'contacted' } },
        { type: 'sequence_stopped', payload: { reason: 'opted_out' } },
      ]);
      expect(queue.enqueueSendMessage).not.toHaveBeenCalled();

      // Anything still queued for the lead is dropped at send time.
      const outcome = await createSendMessage({
        db,
        adapters: { email: fakeAdapter() },
        queue: fakeQueue(),
      })(
        {
          leadId: lead.id,
          kind: 'first_contact',
          channel: 'email',
          template: names.firstEmail,
          dedupeKey: `first-contact:${lead.id}:other`,
        },
        { final: false },
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'status is do_not_contact' });
    });

    it('opts out through the unsubscribe link, once', async () => {
      const lead = await createLead();
      await firstContact(lead.id);
      const optOut = createOptOut(db);

      expect(await optOut(lead.id)).toBe(true);
      expect(await optOut(lead.id)).toBe(false);
      expect(await optOut(randomUUID())).toBe(false);
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
        'do_not_contact',
      );
      expect(await db.leadEvent.count({ where: { leadId: lead.id, type: 'opted_out' } })).toBe(1);
    });

    it('ignores messages from unknown senders', async () => {
      const { handle } = inbound();
      expect(await handle(whatsappReply('+5511900000000', 'hello?'))).toEqual({
        status: 'unmatched',
      });
    });
  });

  describe('reconcileEnrollments', () => {
    it('re-queues active enrollments that are due soon, and nothing else', async () => {
      const soon = await createLead();
      const later = await createLead();
      const done = await createLead();
      await firstContact(soon.id);
      await firstContact(later.id);
      await firstContact(done.id);
      const [soonE, laterE, doneE] = await Promise.all([
        enrollmentOf(soon.id),
        enrollmentOf(later.id),
        enrollmentOf(done.id),
      ]);
      const now = new Date();
      await db.enrollment.update({
        where: { id: soonE.id },
        data: { nextRunAt: new Date(now.getTime() + 5 * MINUTE) },
      });
      await db.enrollment.update({
        where: { id: laterE.id },
        data: { nextRunAt: new Date(now.getTime() + DAY) },
      });
      await db.enrollment.update({
        where: { id: doneE.id },
        data: { status: 'completed', nextRunAt: now },
      });

      const enqueued: FollowUpStepJob[] = [];
      await reconcileEnrollments(db, async (job) => void enqueued.push(job), {
        now,
        horizonMs: 20 * MINUTE,
      });

      const mine = enqueued.filter((j) => [soonE.id, laterE.id, doneE.id].includes(j.enrollmentId));
      expect(mine).toEqual([
        { enrollmentId: soonE.id, step: 1, runAt: now.getTime() + 5 * MINUTE },
      ]);
    });
  });

  describe.skipIf(!redisUrl)('end to end with Redis', () => {
    it('runs a whole sequence through BullMQ, and a WhatsApp reply stops another', async () => {
      const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      const queue = createJobQueue(redis);
      const workerConnection = redis.duplicate();
      const adapters = { email: fakeAdapter(), whatsapp: fakeAdapter() };
      const send = createSendMessage({ db, adapters, queue, followUpSequences: sequences });
      const runStep = createRunFollowUpStep({
        db,
        queue,
        quietHours: { ...quietHours, channels: [] },
      });
      const workers = [
        new Worker<SendMessageJob>(SEND_MESSAGE, (job) => runSendMessageJob(send, job), {
          connection: workerConnection,
        }),
        new Worker<FollowUpStepJob>(FOLLOW_UP_STEP, (job) => runStep(job.data), {
          connection: workerConnection,
        }),
      ];
      const app = await buildApp(
        testAppDeps({
          replyAdapters: createReplyAdapters({
            WHATSAPP_APP_SECRET: 'e2e-app-secret',
            REPLY_WEBHOOK_SECRET: undefined,
          }),
          handleInbound: createHandleInbound({ db, queue, optOutKeywords: ['STOP'] }),
        }),
      );
      const firstContactJob = (leadId: string): SendMessageJob => ({
        leadId,
        kind: 'first_contact',
        channel: 'email',
        template: names.firstEmail,
        dedupeKey: firstContactKey(leadId, 'email'),
      });

      try {
        // Warm uses the instant sequence: every step and the completion check are due at once.
        const silent = await createLead({ tier: 'warm' });
        await queue.enqueueSendMessage(firstContactJob(silent.id));
        await vi.waitFor(
          async () => {
            expect((await db.lead.findUniqueOrThrow({ where: { id: silent.id } })).status).toBe(
              'unresponsive',
            );
          },
          { timeout: 15_000, interval: 100 },
        );
        const sent = await db.leadEvent.findMany({
          where: { leadId: silent.id, type: 'message_sent' },
          orderBy: { createdAt: 'asc' },
        });
        expect(sent.map((e) => [(e.payload as { kind: string }).kind, e.channel])).toEqual([
          ['first_contact', 'email'],
          ['follow_up', 'whatsapp'],
          ['follow_up', 'email'],
          ['follow_up', 'email'],
        ]);

        // Hot uses the real-time sequence: its first step is an hour away.
        const replier = await createLead();
        await queue.enqueueSendMessage(firstContactJob(replier.id));
        await vi.waitFor(async () => expect(await enrollmentOf(replier.id)).toBeTruthy(), {
          timeout: 10_000,
          interval: 100,
        });
        const body = JSON.stringify({
          object: 'whatsapp_business_account',
          entry: [
            {
              changes: [
                {
                  value: {
                    messages: [
                      {
                        from: replier.phone!.slice(1),
                        id: `wamid.${randomUUID()}`,
                        timestamp: String(Math.floor(Date.now() / 1000)),
                        type: 'text',
                        text: { body: 'Call me' },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        });
        const res = await app.inject({
          method: 'POST',
          url: '/webhooks/replies/whatsapp',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': whatsappSignature('e2e-app-secret', body),
          },
          payload: body,
        });
        expect(res.json().results).toMatchObject([{ status: 'replied', engaged: true }]);

        // Pretend the hour passed: run the step now. It must not send anything.
        const enrollment = await enrollmentOf(replier.id);
        await queue.enqueueFollowUpStep({
          enrollmentId: enrollment.id,
          step: 1,
          runAt: Date.now(),
        });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(
          await db.leadEvent.count({ where: { leadId: replier.id, type: 'message_sent' } }),
        ).toBe(1);
        expect(enrollment.status).toBe('stopped');
      } finally {
        await app.close();
        await Promise.all(workers.map((w) => w.close()));
        await queue.close();
        redis.disconnect();
        workerConnection.disconnect();
      }
    });
  });
});
