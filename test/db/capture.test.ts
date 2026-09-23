// Runs against the real Postgres (and Redis for the end-to-end case): `npm run test:db`.
// Skipped when DATABASE_URL is not set, e.g. in CI.
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createFormAdapters } from '../../src/capture/adapters/index.js';
import { createCaptureLead } from '../../src/capture/captureLead.js';
import type { LeadInput } from '../../src/capture/types.js';
import { createDb } from '../../src/db.js';
import { LEAD_CAPTURED, createJobQueue, type JobQueue } from '../../src/queue.js';
import { fakeQueue, testAppDeps } from '../helpers.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];

describe.skipIf(!databaseUrl)('captureLead (database)', () => {
  const db = createDb(databaseUrl!);
  const leadIds = new Set<string>();

  afterAll(async () => {
    await db.lead.deleteMany({ where: { id: { in: [...leadIds] } } });
    await db.$disconnect();
  });

  function leadInput(overrides: Partial<LeadInput> = {}): LeadInput {
    return {
      externalId: randomUUID(),
      firstName: 'Test',
      lastName: null,
      email: `lead-${randomUUID()}@example.com`,
      phone: null,
      company: null,
      timezone: null,
      utm: null,
      fields: {},
      consentEmail: false,
      consentMessaging: false,
      ...overrides,
    };
  }

  async function capture(queue: JobQueue, input: LeadInput) {
    const result = await createCaptureLead(db, queue)({ source: 'test', input, rawPayload: input });
    leadIds.add(result.leadId);
    return result;
  }

  const countLeads = (email: string) => db.lead.count({ where: { email } });
  const capturedEvents = (leadId: string) =>
    db.leadEvent.findMany({ where: { leadId, type: 'captured' } });

  it('creates exactly one lead and one event when the same webhook is replayed', async () => {
    const queue = fakeQueue();
    const input = leadInput();

    const first = await capture(queue, input);
    const replay = await capture(queue, input);

    expect(first.duplicate).toBe(false);
    expect(replay).toEqual({ ...first, duplicate: true });
    expect(await countLeads(input.email!)).toBe(1);
    expect(await capturedEvents(first.leadId)).toHaveLength(1);
    // The replay re-enqueues with the same job id, which BullMQ ignores if the job exists.
    expect(queue.enqueueLeadCaptured.mock.calls).toEqual([
      [{ leadId: first.leadId, eventId: first.eventId }],
      [{ leadId: first.leadId, eventId: first.eventId }],
    ]);
  });

  it('matches on email or phone and fills the blanks of the oldest matching lead', async () => {
    const queue = fakeQueue();
    const email = `lead-${randomUUID()}@example.com`;
    const phone = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

    const first = await capture(
      queue,
      leadInput({
        email,
        firstName: 'Ana',
        utm: { source: 'google' },
        fields: { budget: '5k', size: '10' },
      }),
    );
    // Shares no email/phone with the first, so it becomes a separate lead.
    const second = await capture(
      queue,
      leadInput({
        email: null,
        phone,
        firstName: 'Ana Maria',
        company: 'Acme',
        utm: { source: 'facebook' },
        fields: { budget: '10k' },
        consentMessaging: true,
      }),
    );
    // Matches both by email and phone; merges into the oldest and adds the phone to it.
    const third = await capture(queue, leadInput({ email, phone }));

    expect(second.leadId).not.toBe(first.leadId);
    expect(third.leadId).toBe(first.leadId);

    const lead = await db.lead.findUniqueOrThrow({ where: { id: first.leadId } });
    expect(lead).toMatchObject({
      email,
      phone,
      firstName: 'Ana',
      utm: { source: 'google' },
      fields: { budget: '5k', size: '10' },
    });
    expect(await capturedEvents(first.leadId)).toHaveLength(2);
  });

  it('fills blanks, merges answers and keeps consent when merging', async () => {
    const queue = fakeQueue();
    const email = `lead-${randomUUID()}@example.com`;

    const first = await capture(
      queue,
      leadInput({
        email,
        firstName: 'Ana',
        fields: { budget: '5k', size: '10' },
        consentEmail: true,
      }),
    );
    await capture(
      queue,
      leadInput({
        email,
        firstName: 'Ana Maria',
        company: 'Acme',
        utm: { source: 'facebook' },
        fields: { budget: '10k' },
        consentEmail: false,
        consentMessaging: true,
      }),
    );

    const lead = await db.lead.findUniqueOrThrow({ where: { id: first.leadId } });
    expect(lead).toMatchObject({
      firstName: 'Ana',
      company: 'Acme',
      utm: { source: 'facebook' },
      fields: { budget: '10k', size: '10' },
      consentEmail: true,
      consentMessaging: true,
    });
  });

  it('creates one lead when the same delivery arrives concurrently', async () => {
    const queue = fakeQueue();
    const input = leadInput();

    const results = await Promise.all(Array.from({ length: 5 }, () => capture(queue, input)));

    expect(new Set(results.map((r) => r.leadId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await countLeads(input.email!)).toBe(1);
  });

  it('creates one lead when different submissions from the same person arrive concurrently', async () => {
    const queue = fakeQueue();
    const email = `lead-${randomUUID()}@example.com`;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => capture(queue, leadInput({ email }))),
    );

    expect(new Set(results.map((r) => r.leadId)).size).toBe(1);
    expect(await countLeads(email)).toBe(1);
    expect(await capturedEvents(results[0]!.leadId)).toHaveLength(5);
  });

  it('keeps the lead when enqueueing fails, and enqueues it on the retry', async () => {
    const queue = fakeQueue();
    queue.enqueueLeadCaptured.mockRejectedValueOnce(new Error('redis down'));
    const input = leadInput();

    await expect(capture(queue, input)).rejects.toThrow('redis down');
    const retry = await capture(queue, input);

    expect(retry.duplicate).toBe(true);
    expect(await countLeads(input.email!)).toBe(1);
    expect(queue.enqueueLeadCaptured).toHaveBeenLastCalledWith({
      leadId: retry.leadId,
      eventId: retry.eventId,
    });
  });

  describe.skipIf(!redisUrl)('end to end with Redis', () => {
    it('a replayed website webhook creates one lead and one lead.captured job', async () => {
      const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      const queue = createJobQueue(redis);
      const inspect = new Queue(LEAD_CAPTURED, { connection: redis });
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
        const email = `lead-${randomUUID()}@example.com`;
        const submissionId = randomUUID();
        const send = () =>
          app.inject({
            method: 'POST',
            url: '/webhooks/forms/website',
            headers: { 'x-webhook-secret': 'e2e-secret' },
            payload: { submissionId, name: 'E2E Lead', email },
          });

        const first = await send();
        const replay = await send();
        const { leadId, eventId } = first.json();
        leadIds.add(leadId);

        expect(first.statusCode).toBe(200);
        expect(replay.json()).toMatchObject({ leadId, eventId, duplicate: true });
        expect(await countLeads(email)).toBe(1);

        const jobs = (await inspect.getJobs()).filter((j) => j.data.leadId === leadId);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.id).toBe(eventId);
        await jobs[0]!.remove();
      } finally {
        await app.close();
        await inspect.close();
        await queue.close();
        redis.disconnect();
      }
    });
  });
});
