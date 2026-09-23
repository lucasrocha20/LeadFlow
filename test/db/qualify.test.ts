// Runs against the real Postgres (and Redis for the end-to-end case): `npm run test:db`.
// Skipped when DATABASE_URL is not set, e.g. in CI.
import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createCaptureLead } from '../../src/capture/captureLead.js';
import type { LeadInput } from '../../src/capture/types.js';
import { createDb } from '../../src/db.js';
import { createQualifyLead } from '../../src/qualification/qualifyLead.js';
import { loadScoringRules, parseScoringRules } from '../../src/qualification/rules.js';
import {
  LEAD_CAPTURED,
  LEAD_QUALIFIED,
  createJobQueue,
  type LeadCapturedJob,
} from '../../src/queue.js';
import { fakeQueue } from '../helpers.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];

const rules = parseScoringRules({
  tiers: { hot: 30, warm: 10 },
  rules: [
    { id: 'phone', points: 10, when: { fact: 'phone', op: 'exists', value: true } },
    { id: 'company', points: 20, when: { fact: 'company', op: 'exists', value: true } },
  ],
  disqualifiers: [{ id: 'spam', when: { fact: 'text', op: 'matches', value: 'casino' } }],
});

describe.skipIf(!databaseUrl)('qualifyLead (database)', () => {
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
      consentEmail: true,
      consentMessaging: false,
      ...overrides,
    };
  }

  async function capture(input: LeadInput): Promise<LeadCapturedJob> {
    const { leadId, eventId } = await createCaptureLead(
      db,
      fakeQueue(),
    )({ source: 'test', input, rawPayload: {} });
    leadIds.add(leadId);
    return { leadId, eventId };
  }

  const uniquePhone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

  const scoredEvents = (leadId: string) =>
    db.leadEvent.findMany({ where: { leadId, type: 'scored' }, orderBy: { createdAt: 'asc' } });

  it('saves score, tier and status, records a scored event and enqueues lead.qualified', async () => {
    const queue = fakeQueue();
    const job = await capture(leadInput({ phone: uniquePhone(), company: 'Acme' }));

    const result = await createQualifyLead(db, queue, rules)(job);

    expect(result).toMatchObject({ leadId: job.leadId, score: 30, tier: 'hot', duplicate: false });
    expect(await db.lead.findUniqueOrThrow({ where: { id: job.leadId } })).toMatchObject({
      score: 30,
      tier: 'hot',
      status: 'qualified',
    });
    const [event, ...others] = await scoredEvents(job.leadId);
    expect(others).toHaveLength(0);
    expect(event).toMatchObject({
      id: result!.eventId,
      dedupeKey: `scored:${job.eventId}`,
      payload: {
        score: 30,
        tier: 'hot',
        matchedRules: [
          { id: 'phone', points: 10 },
          { id: 'company', points: 20 },
        ],
        disqualifiedBy: [],
        capturedEventId: job.eventId,
        previous: { score: null, tier: null, status: 'new' },
        status: 'qualified',
      },
    });
    expect(queue.enqueueLeadQualified).toHaveBeenCalledExactlyOnceWith({
      leadId: job.leadId,
      eventId: result!.eventId,
      score: 30,
      tier: 'hot',
    });
  });

  it('is idempotent when the job runs again', async () => {
    const queue = fakeQueue();
    const qualify = createQualifyLead(db, queue, rules);
    const job = await capture(leadInput({ phone: uniquePhone() }));

    const first = await qualify(job);
    const retry = await qualify(job);

    expect(retry).toEqual({ ...first, duplicate: true });
    expect(await scoredEvents(job.leadId)).toHaveLength(1);
    // Re-enqueued with the same job id, which BullMQ ignores when the job still exists.
    expect(queue.enqueueLeadQualified.mock.calls).toEqual([
      [{ leadId: job.leadId, eventId: first!.eventId, score: 10, tier: 'warm' }],
      [{ leadId: job.leadId, eventId: first!.eventId, score: 10, tier: 'warm' }],
    ]);
  });

  it('marks disqualified leads and does not pass them on', async () => {
    const queue = fakeQueue();
    const job = await capture(leadInput({ company: 'Casino Royale', phone: uniquePhone() }));

    const result = await createQualifyLead(db, queue, rules)(job);

    expect(result).toMatchObject({ score: 30, tier: 'disqualified', disqualifiedBy: ['spam'] });
    expect(await db.lead.findUniqueOrThrow({ where: { id: job.leadId } })).toMatchObject({
      tier: 'disqualified',
      status: 'disqualified',
    });
    expect(queue.enqueueLeadQualified).not.toHaveBeenCalled();
  });

  it('rescores when the same person submits again, without touching a later status', async () => {
    const queue = fakeQueue();
    const qualify = createQualifyLead(db, queue, rules);
    const email = `lead-${randomUUID()}@example.com`;

    const first = await capture(leadInput({ email }));
    expect(await qualify(first)).toMatchObject({ score: 0, tier: 'cold' });

    // Meanwhile the lead was contacted (Phase 3); a new form fills in the company.
    await db.lead.update({ where: { id: first.leadId }, data: { status: 'contacted' } });
    const second = await capture(leadInput({ email, company: 'Acme' }));
    expect(second.leadId).toBe(first.leadId);

    expect(await qualify(second)).toMatchObject({ score: 20, tier: 'warm', duplicate: false });
    expect(await db.lead.findUniqueOrThrow({ where: { id: first.leadId } })).toMatchObject({
      score: 20,
      tier: 'warm',
      status: 'contacted',
    });
    const events = await scoredEvents(first.leadId);
    expect(events.map((e) => e.payload)).toMatchObject([
      { tier: 'cold', status: 'qualified' },
      { tier: 'warm', status: 'contacted', previous: { tier: 'cold', status: 'contacted' } },
    ]);
  });

  it('returns null when the lead no longer exists', async () => {
    const queue = fakeQueue();
    const job = await capture(leadInput());
    await db.lead.delete({ where: { id: job.leadId } });

    expect(await createQualifyLead(db, queue, rules)(job)).toBeNull();
    expect(queue.enqueueLeadQualified).not.toHaveBeenCalled();
  });

  describe.skipIf(!redisUrl)('end to end with Redis', () => {
    it('a captured lead is scored by the worker and handed to lead.qualified', async () => {
      const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      const queue = createJobQueue(redis);
      const qualified = new Queue(LEAD_QUALIFIED, { connection: redis });
      const captured = new Queue(LEAD_CAPTURED, { connection: redis });
      const eventsConnection = redis.duplicate();
      const workerConnection = redis.duplicate();
      const events = new QueueEvents(LEAD_CAPTURED, { connection: eventsConnection });
      const qualify = createQualifyLead(db, queue, loadScoringRules('config/scoring.json'));
      const worker = new Worker<LeadCapturedJob>(LEAD_CAPTURED, (job) => qualify(job.data), {
        connection: workerConnection,
      });

      try {
        await events.waitUntilReady();
        const { leadId, eventId } = await createCaptureLead(
          db,
          queue,
        )({
          source: 'website',
          input: leadInput({ email: `ceo-${randomUUID()}@bigcorp.com`, company: 'BigCorp' }),
          rawPayload: {},
        });
        leadIds.add(leadId);

        const capturedJob = await captured.getJob(eventId);
        await capturedJob!.waitUntilFinished(events, 10_000);

        const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
        // business-email 20 + has-company 5 + source-website 5
        expect(lead).toMatchObject({ score: 30, tier: 'warm', status: 'qualified' });

        const [scored] = await scoredEvents(leadId);
        const next = await qualified.getJob(scored!.id);
        expect(next?.data).toEqual({ leadId, eventId: scored!.id, score: 30, tier: 'warm' });
        await next!.remove();
        await capturedJob!.remove();
      } finally {
        await worker.close();
        await events.close();
        await captured.close();
        await qualified.close();
        await queue.close();
        [redis, eventsConnection, workerConnection].forEach((c) => c.disconnect());
      }
    });
  });
});
