// Runs against the real Postgres (and Redis for the end-to-end cases): `npm run test:db`.
// Skipped when DATABASE_URL is not set, e.g. in CI.
import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parseCrmConfig, type CrmConfig } from '../../src/crm/config.js';
import {
  SYNC_LAG_MS,
  createSyncLead,
  deadLetterCrmSync,
  findLeadsToSync,
  requeueDeadLetters,
  runCrmSyncJob,
} from '../../src/crm/syncLead.js';
import {
  CrmNotFoundError,
  CrmRateLimitError,
  type CrmActivity,
  type CrmAdapter,
  type CrmContact,
} from '../../src/crm/types.js';
import { hubspotWebhook } from '../../src/crm/webhook.js';
import { createDb } from '../../src/db.js';
import type { LeadEventType, Prisma } from '../../src/generated/prisma/client.js';
import { CRM_SYNC, createJobQueue, type CrmSyncJob } from '../../src/queue.js';
import { fakeQueue } from '../helpers.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];

// Past the sync lag, so events created just now are eligible.
const later = () => new Date(Date.now() + SYNC_LAG_MS + 1_000);

const config: CrmConfig = parseCrmConfig({
  syncDisqualified: false,
  stages: {
    new: { hs_lead_status: 'NEW' },
    qualified: { hs_lead_status: 'OPEN' },
    contacted: { hs_lead_status: 'ATTEMPTED_TO_CONTACT' },
    engaged: { hs_lead_status: 'CONNECTED' },
    unresponsive: { hs_lead_status: 'BAD_TIMING' },
    disqualified: { hs_lead_status: 'UNQUALIFIED' },
    do_not_contact: { hs_lead_status: 'UNQUALIFIED' },
    converted: { lifecyclestage: 'customer' },
  },
  owners: { hot: 'owner-hot' },
  inbound: [{ property: 'lifecyclestage', value: 'customer', status: 'converted' }],
});

/** An in-memory CRM that records what LeadFlow pushed. */
function fakeCrm() {
  const contacts = new Map<
    string,
    { contact: CrmContact; stage: Record<string, string>; owner?: string; notes: CrmActivity[] }
  >();
  const crm = {
    provider: 'fake',
    upsertContact: vi.fn<CrmAdapter['upsertContact']>(async (contact, crmId) => {
      if (crmId) {
        if (!contacts.has(crmId)) throw new CrmNotFoundError(`no contact ${crmId}`);
        contacts.get(crmId)!.contact = contact;
        return crmId;
      }
      const id = `crm-${randomUUID()}`;
      contacts.set(id, { contact, stage: {}, notes: [] });
      return id;
    }),
    updateStage: vi.fn<CrmAdapter['updateStage']>(async (crmId, stage) => {
      Object.assign(contacts.get(crmId)!.stage, stage);
    }),
    assignOwner: vi.fn<CrmAdapter['assignOwner']>(async (crmId, owner) => {
      contacts.get(crmId)!.owner = owner;
    }),
    logActivity: vi.fn<CrmAdapter['logActivity']>(async (crmId, activity) => {
      contacts.get(crmId)!.notes.push(activity);
    }),
    deleteContact: vi.fn<CrmAdapter['deleteContact']>(async (crmId) => {
      contacts.delete(crmId);
    }),
  } satisfies CrmAdapter;
  return { crm, contacts };
}

describe.skipIf(!databaseUrl)('CRM sync (database)', () => {
  const db = createDb(databaseUrl!);
  const leadIds = new Set<string>();

  afterAll(async () => {
    await db.lead.deleteMany({ where: { id: { in: [...leadIds] } } });
    await db.$disconnect();
  });

  async function createLead(
    data: Partial<Prisma.LeadCreateInput> = {},
    events: LeadEventType[] = ['captured', 'scored'],
  ) {
    const lead = await db.lead.create({
      data: {
        source: 'test',
        rawPayload: {},
        firstName: 'Ana',
        email: `lead-${randomUUID()}@example.com`,
        status: 'qualified',
        tier: 'hot',
        score: 80,
        ...data,
      },
    });
    leadIds.add(lead.id);
    for (const type of events) await addEvent(lead.id, type);
    return lead;
  }

  async function addEvent(leadId: string, type: LeadEventType, payload: object = {}) {
    const defaults: Partial<Record<LeadEventType, object>> = {
      captured: { source: 'test' },
      scored: { score: 80, tier: 'hot', matchedRules: [], disqualifiedBy: [] },
      message_sent: { kind: 'first_contact', template: 't' },
    };
    return db.leadEvent.create({
      data: {
        leadId,
        type,
        channel: type === 'message_sent' || type === 'reply_received' ? 'email' : null,
        payload: { ...defaults[type], ...payload },
      },
    });
  }

  const sync = (crm: CrmAdapter, cfg: CrmConfig = config) =>
    createSyncLead({ db, crm, config: cfg, now: later });

  it('creates the contact with owner and stage, and logs every event in order, once', async () => {
    const lead = await createLead();
    await addEvent(lead.id, 'message_sent');
    const { crm, contacts } = fakeCrm();

    const outcome = await sync(crm)(lead.id);

    expect(outcome).toMatchObject({ status: 'synced', events: 3, created: true });
    const saved = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    const record = contacts.get(saved.crmId!)!;
    expect(record.contact).toMatchObject({ email: lead.email, firstName: 'Ana' });
    expect(record.owner).toBe('owner-hot');
    expect(record.stage).toEqual({ hs_lead_status: 'OPEN' });
    expect(record.notes.map((n) => n.title)).toEqual([
      'LeadFlow: Lead captured from test',
      'LeadFlow: Scored 80 → hot',
      'LeadFlow: Email first contact sent',
    ]);
    const events = await db.leadEvent.findMany({ where: { leadId: lead.id, type: 'crm_synced' } });
    expect(events).toMatchObject([{ payload: { crmId: saved.crmId, provider: 'fake' } }]);

    // Nothing new: no CRM calls at all.
    crm.upsertContact.mockClear();
    expect(await sync(crm)(lead.id)).toEqual({ status: 'up_to_date' });
    expect(crm.upsertContact).not.toHaveBeenCalled();
  });

  it('pushes only new events later, updates the stage and keeps the owner', async () => {
    const lead = await createLead();
    const { crm, contacts } = fakeCrm();
    await sync(crm)(lead.id);

    await db.lead.update({ where: { id: lead.id }, data: { status: 'engaged' } });
    await addEvent(lead.id, 'reply_received', { text: 'Call me' });
    const outcome = await sync(crm)(lead.id);

    expect(outcome).toMatchObject({ status: 'synced', events: 1, created: false });
    const record = [...contacts.values()][0]!;
    expect(record.stage).toEqual({ hs_lead_status: 'CONNECTED' });
    expect(record.notes.map((n) => n.title)).toEqual([
      'LeadFlow: Lead captured from test',
      'LeadFlow: Scored 80 → hot',
      'LeadFlow: Reply received on Email',
    ]);
    expect(crm.assignOwner).toHaveBeenCalledOnce();
  });

  it('holds back events younger than the sync lag', async () => {
    const lead = await createLead();
    const { crm } = fakeCrm();
    const outcome = await createSyncLead({ db, crm, config, now: () => new Date() })(lead.id);
    expect(outcome).toEqual({ status: 'up_to_date' });
    expect(await findLeadsToSync(db, { syncDisqualified: false })).not.toContain(lead.id);
    expect(await findLeadsToSync(db, { now: later(), syncDisqualified: false })).toContain(lead.id);
  });

  it('resumes after a failure without logging an event twice', async () => {
    const lead = await createLead();
    await addEvent(lead.id, 'message_sent');
    const { crm, contacts } = fakeCrm();
    crm.logActivity.mockImplementationOnce(async (crmId, activity) => {
      contacts.get(crmId)!.notes.push(activity);
    });
    crm.logActivity.mockRejectedValueOnce(new Error('hubspot 502'));

    await expect(sync(crm)(lead.id)).rejects.toThrow('502');
    expect(await sync(crm)(lead.id)).toMatchObject({ status: 'synced', events: 2 });

    const titles = [...contacts.values()][0]!.notes.map((n) => n.title);
    expect(titles).toEqual([
      'LeadFlow: Lead captured from test',
      'LeadFlow: Scored 80 → hot',
      'LeadFlow: Email first contact sent',
    ]);
    expect(crm.upsertContact).toHaveBeenCalledTimes(2);
    expect(crm.upsertContact.mock.calls[1]![1]).toBe(
      (await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).crmId,
    );
  });

  it('recreates a contact that was deleted in the CRM', async () => {
    const lead = await createLead();
    const { crm, contacts } = fakeCrm();
    await sync(crm)(lead.id);
    const { crmId: oldId } = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    contacts.delete(oldId!);
    await addEvent(lead.id, 'message_sent');

    await sync(crm)(lead.id);

    const { crmId: newId } = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(newId).not.toBe(oldId);
    expect(contacts.get(newId!)!.notes.map((n) => n.title)).toEqual([
      'LeadFlow: Email first contact sent',
    ]);
    const synced = await db.leadEvent.findMany({
      where: { leadId: lead.id, type: 'crm_synced' },
      orderBy: { createdAt: 'asc' },
    });
    expect(synced.at(-1)?.payload).toMatchObject({ crmId: newId, replaced: oldId });
  });

  it('skips disqualified leads when configured to', async () => {
    const lead = await createLead({ tier: 'disqualified', status: 'disqualified' });
    const { crm } = fakeCrm();
    expect(await sync(crm)(lead.id)).toMatchObject({ status: 'skipped' });
    expect(await findLeadsToSync(db, { now: later(), syncDisqualified: false })).not.toContain(
      lead.id,
    );
    expect(await sync(crm, { ...config, syncDisqualified: true })(lead.id)).toMatchObject({
      status: 'synced',
    });
  });

  it('dead-letters a lead, skips it until requeued, then syncs it', async () => {
    const lead = await createLead();
    const queue = fakeQueue();
    await deadLetterCrmSync(db, queue, lead.id, new Error('400 invalid property'));

    expect(await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      crmSyncError: '400 invalid property',
    });
    expect(queue.deadLetterCrmSync).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: lead.id, error: '400 invalid property' }),
    );
    const { crm } = fakeCrm();
    expect(await sync(crm)(lead.id)).toEqual({ status: 'skipped', reason: 'dead-lettered' });
    expect(await findLeadsToSync(db, { now: later(), syncDisqualified: false })).not.toContain(
      lead.id,
    );

    expect(await requeueDeadLetters(db, queue, [lead.id])).toBe(1);
    expect(queue.clearCrmDeadLetters).toHaveBeenCalledWith([lead.id]);
    expect(queue.enqueueCrmSync).toHaveBeenCalledWith({ leadId: lead.id });
    const outcome = await sync(crm)(lead.id);
    expect(outcome).toMatchObject({ status: 'synced', events: 2 }); // crm_sync_failed is not pushed
  });

  describe('HubSpot → LeadFlow webhook', () => {
    const webhook = hubspotWebhook({ db, secret: 's', config });
    const change = (crmId: string, value = 'customer') => ({
      eventId: randomUUID(),
      crmId,
      property: 'lifecyclestage',
      value,
    });

    it('marks the lead converted and stops its follow-up, once', async () => {
      const crmId = `crm-${randomUUID()}`;
      const lead = await createLead({ crmId, status: 'contacted' });
      const template = await db.template.create({
        data: { name: `t_${randomUUID()}`, channel: 'email', subject: 's', body: 'b' },
      });
      const sequence = await db.sequence.create({
        data: {
          name: `seq_${randomUUID()}`,
          tier: 'hot',
          steps: {
            create: [{ order: 1, offsetMinutes: 60, channel: 'email', templateId: template.id }],
          },
        },
      });
      await db.enrollment.create({
        data: { leadId: lead.id, sequenceId: sequence.id, currentStep: 1, nextRunAt: new Date() },
      });

      const event = change(crmId);
      expect(await webhook.handle(event)).toEqual({
        status: 'updated',
        leadId: lead.id,
        from: 'contacted',
        to: 'converted',
        stoppedSequences: 1,
      });
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
        'converted',
      );
      expect(await db.enrollment.findFirst({ where: { leadId: lead.id } })).toMatchObject({
        status: 'stopped',
      });
      const statusEvent = await db.leadEvent.findFirstOrThrow({
        where: { leadId: lead.id, type: 'status_changed' },
      });
      expect(statusEvent.payload).toEqual({
        from: 'contacted',
        to: 'converted',
        source: 'crm (lifecyclestage = customer)',
      });

      expect(await webhook.handle(event)).toEqual({ status: 'unchanged', leadId: lead.id });
      await db.enrollment.deleteMany({ where: { sequenceId: sequence.id } });
      await db.sequence.delete({ where: { id: sequence.id } });
      await db.template.delete({ where: { id: template.id } });
    });

    it('ignores other values and unknown contacts', async () => {
      expect(await webhook.handle(change('crm-unknown'))).toEqual({ status: 'unmatched' });
      expect(await webhook.handle(change('crm-unknown', 'lead'))).toEqual({ status: 'ignored' });
    });
  });

  describe.skipIf(!redisUrl)('end to end with Redis', () => {
    it('syncs through BullMQ, waiting out a 429 without using up an attempt', async () => {
      const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      const queue = createJobQueue(redis);
      const workerConnection = redis.duplicate();
      const { crm, contacts } = fakeCrm();
      crm.upsertContact.mockRejectedValueOnce(new CrmRateLimitError('429', 300));
      const syncLead = createSyncLead({ db, crm, config, now: later });
      const deadLetter = vi.fn(async () => {});
      const worker: Worker<CrmSyncJob> = new Worker<CrmSyncJob>(
        CRM_SYNC,
        (job) =>
          runCrmSyncJob(syncLead, job, {
            deadLetter,
            rateLimit: async (ms) => {
              await worker.rateLimit(ms);
              return Worker.RateLimitError();
            },
          }),
        { connection: workerConnection },
      );

      try {
        const lead = await createLead();
        const started = Date.now();
        for (const leadId of await findLeadsToSync(db, { now: later(), syncDisqualified: false })) {
          if (leadId === lead.id) await queue.enqueueCrmSync({ leadId });
        }

        await vi.waitFor(
          async () => {
            const { crmId } = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
            expect(crmId && contacts.get(crmId)?.notes).toHaveLength(2);
          },
          { timeout: 10_000, interval: 50 },
        );
        expect(Date.now() - started).toBeGreaterThanOrEqual(300);
        expect(crm.upsertContact).toHaveBeenCalledTimes(2);
        expect(deadLetter).not.toHaveBeenCalled();
      } finally {
        await worker.close();
        await queue.close();
        redis.disconnect();
        workerConnection.disconnect();
      }
    });
  });
});
