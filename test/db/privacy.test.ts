// Runs against the real Postgres: `npm run test:db`. Skipped when DATABASE_URL is not set.
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createCaptureLead } from '../../src/capture/captureLead.js';
import type { LeadInput } from '../../src/capture/types.js';
import type { CrmAdapter } from '../../src/crm/types.js';
import { createDb } from '../../src/db.js';
import { createOptOut } from '../../src/inbound/optOut.js';
import {
  eraseLeads,
  exportSubject,
  findExpiredLeads,
  findSubjectLeadIds,
} from '../../src/privacy/erasure.js';
import { addressHashes } from '../../src/privacy/suppression.js';
import { fakeQueue } from '../helpers.js';

const databaseUrl = process.env['DATABASE_URL'];
const DAY = 24 * 60 * 60_000;

describe.skipIf(!databaseUrl)('privacy (database)', () => {
  const db = createDb(databaseUrl!);
  const emails = new Set<string>();
  const phones = new Set<string>();

  afterAll(async () => {
    const or = [{ email: { in: [...emails] } }, { phone: { in: [...phones] } }];
    await db.lead.deleteMany({ where: { OR: or } });
    const hashes = [...emails].flatMap((email) => addressHashes({ email }));
    hashes.push(...[...phones].flatMap((phone) => addressHashes({ phone })));
    await db.suppression.deleteMany({ where: { hash: { in: hashes } } });
    await db.erasure.deleteMany({ where: { subjectHashes: { hasSome: hashes } } });
    await db.$disconnect();
  });

  const newEmail = () => {
    const email = `privacy-${randomUUID().slice(0, 8)}@example.com`;
    emails.add(email);
    return email;
  };
  const newPhone = () => {
    const phone = `+55219${String(randomInt(10_000_000, 99_999_999))}`;
    phones.add(phone);
    return phone;
  };

  function input(overrides: Partial<LeadInput> = {}): LeadInput {
    return {
      externalId: randomUUID(),
      firstName: 'Test',
      lastName: null,
      email: newEmail(),
      phone: null,
      company: null,
      timezone: null,
      utm: null,
      fields: {},
      consentEmail: true,
      consentMessaging: false,
      consentEvidence: { text: 'I agree', version: 'v1' },
      ...overrides,
    };
  }

  const capture = (i: LeadInput) =>
    createCaptureLead(db, fakeQueue())({ source: 'website', input: i, rawPayload: i });

  const fakeCrm = () =>
    ({
      provider: 'fake',
      upsertContact: vi.fn(),
      updateStage: vi.fn(),
      assignOwner: vi.fn(),
      logActivity: vi.fn(),
      deleteContact: vi.fn<CrmAdapter['deleteContact']>(async () => {}),
    }) satisfies CrmAdapter;

  describe('consent ledger', () => {
    it('records each grant with its evidence, and the withdrawal on opt-out', async () => {
      const { leadId } = await capture(input({ consentMessaging: true }));
      const grants = await db.consentRecord.findMany({ where: { leadId } });
      expect(grants.map((g) => [g.purpose, g.granted, g.source]).sort()).toEqual([
        ['email', true, 'website'],
        ['messaging', true, 'website'],
      ]);
      expect(grants[0]!.evidence).toEqual({ text: 'I agree', version: 'v1' });

      await db.lead.update({ where: { id: leadId }, data: { status: 'contacted' } });
      await createOptOut(db)(leadId);
      const lead = await db.lead.findUniqueOrThrow({
        where: { id: leadId },
        include: { consents: { where: { granted: false } } },
      });
      expect(lead).toMatchObject({
        status: 'do_not_contact',
        consentEmail: false,
        consentMessaging: false,
      });
      expect(lead.consents.map((c) => [c.purpose, c.source]).sort()).toEqual([
        ['email', 'unsubscribe_link'],
        ['messaging', 'unsubscribe_link'],
      ]);
    });

    it('records nothing when no consent was given', async () => {
      const { leadId } = await capture(input({ consentEmail: false }));
      expect(await db.consentRecord.count({ where: { leadId } })).toBe(0);
    });
  });

  describe('erasure request', () => {
    it('deletes the leads with everything attached, suppresses and logs the addresses', async () => {
      const email = newEmail();
      const phone = newPhone();
      const { leadId } = await capture(input({ email, phone }));
      expect(await findSubjectLeadIds(db, { email })).toEqual([leadId]);

      const result = await eraseLeads(db, [leadId], { reason: 'request' });
      expect(result).toEqual({ erased: 1, crmDeleted: 0, suppressed: 2 });
      expect(await db.lead.count({ where: { id: leadId } })).toBe(0);
      expect(await db.leadEvent.count({ where: { leadId } })).toBe(0);
      expect(await db.consentRecord.count({ where: { leadId } })).toBe(0);

      const hashes = addressHashes({ email, phone });
      expect(await db.suppression.count({ where: { hash: { in: hashes } } })).toBe(2);
      const log = await db.erasure.findFirstOrThrow({
        where: { subjectHashes: { hasEvery: hashes } },
      });
      expect(log).toMatchObject({ reason: 'request', leadCount: 1 });
    });

    it('suppresses the requested address even when no lead matches', async () => {
      const email = newEmail();
      const result = await eraseLeads(db, [], { reason: 'request', extraSubject: { email } });
      expect(result).toEqual({ erased: 0, crmDeleted: 0, suppressed: 1 });
      expect((await exportSubject(db, { email })).suppressed).toBe(true);
    });

    it('a suppressed person who submits again is captured but not contactable', async () => {
      const email = newEmail();
      await eraseLeads(db, [], { reason: 'request', extraSubject: { email } });
      const fresh = await capture(input({ email }));
      expect(await db.lead.findUnique({ where: { id: fresh.leadId } })).toMatchObject({
        status: 'do_not_contact',
        consentEmail: false,
      });
    });

    it('a merge that brings a suppressed address into an existing lead opts it out', async () => {
      const email = newEmail();
      const phone = newPhone();
      await eraseLeads(db, [], { reason: 'request', extraSubject: { email } });
      // A lead known only by phone, already in contact.
      const phoneOnly = await capture(input({ email: null, phone }));
      await db.lead.update({ where: { id: phoneOnly.leadId }, data: { status: 'contacted' } });

      const merged = await capture(input({ email, phone }));
      expect(merged.leadId).toBe(phoneOnly.leadId);
      const blocked = await db.lead.findUniqueOrThrow({
        where: { id: phoneOnly.leadId },
        include: { events: { where: { type: 'opted_out' } } },
      });
      expect(blocked.status).toBe('do_not_contact');
      expect(blocked.events.map((e) => e.payload)).toEqual([
        { source: 'suppression_list', previousStatus: 'contacted' },
      ]);
    });

    it('deletes CRM contacts first; if the CRM fails nothing is erased and a retry works', async () => {
      const { leadId } = await capture(input());
      await db.lead.update({ where: { id: leadId }, data: { crmId: 'hs-1' } });
      const crm = fakeCrm();
      crm.deleteContact.mockRejectedValueOnce(new Error('HubSpot 503'));

      await expect(eraseLeads(db, [leadId], { reason: 'request', crm })).rejects.toThrow('503');
      // Still here, but parked so the sync can't recreate the contact meanwhile.
      expect(await db.lead.findUnique({ where: { id: leadId } })).toMatchObject({
        crmSyncError: 'erasure in progress',
      });

      expect(await eraseLeads(db, [leadId], { reason: 'request', crm })).toMatchObject({
        erased: 1,
        crmDeleted: 1,
      });
      expect(crm.deleteContact).toHaveBeenLastCalledWith('hs-1');
    });
  });

  describe('retention', () => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 365 * DAY);
    const old = new Date(now.getTime() - 400 * DAY);

    async function oldLead(status: 'contacted' | 'do_not_contact' = 'contacted') {
      const email = newEmail();
      const lead = await db.lead.create({
        data: { source: 'test', rawPayload: {}, email, status, createdAt: old, updatedAt: old },
      });
      await db.leadEvent.create({ data: { leadId: lead.id, type: 'captured', createdAt: old } });
      return { ...lead, email };
    }

    it('finds leads with no activity since the cutoff and no follow-up in progress', async () => {
      const expired = await oldLead();
      const recentEvent = await oldLead();
      await db.leadEvent.create({ data: { leadId: recentEvent.id, type: 'reply_received' } });
      const inSequence = await oldLead();
      const sequence = await db.sequence.findFirst();
      if (sequence) {
        await db.enrollment.create({
          data: { leadId: inSequence.id, sequenceId: sequence.id, status: 'paused' },
        });
        // An enrollment write doesn't touch the lead; keep it old.
        await db.lead.update({ where: { id: inSequence.id }, data: { updatedAt: old } });
      }

      const found = await findExpiredLeads(db, cutoff, 10_000);
      expect(found).toContain(expired.id);
      expect(found).not.toContain(recentEvent.id);
      if (sequence) expect(found).not.toContain(inSequence.id);
    });

    it('keeps opted-out addresses suppressed, and logs no personal data', async () => {
      const optedOut = await oldLead('do_not_contact');
      const plain = await oldLead();
      const result = await eraseLeads(db, [optedOut.id, plain.id], { reason: 'retention' });
      expect(result).toEqual({ erased: 2, crmDeleted: 0, suppressed: 1 });
      const [optedOutHash] = addressHashes({ email: optedOut.email });
      const [plainHash] = addressHashes({ email: plain.email });
      expect(await db.suppression.findUnique({ where: { hash: optedOutHash! } })).toMatchObject({
        reason: 'opted_out',
      });
      expect(await db.suppression.findUnique({ where: { hash: plainHash! } })).toBeNull();
      const log = await db.erasure.findFirstOrThrow({
        where: { reason: 'retention' },
        orderBy: { createdAt: 'desc' },
      });
      expect(log.subjectHashes).toEqual([]);
    });
  });

  describe('export', () => {
    it('returns every lead of the subject with events, enrollments and consent records', async () => {
      const email = newEmail();
      const { leadId } = await capture(input({ email }));
      const data = await exportSubject(db, { email });
      expect(data.suppressed).toBe(false);
      expect(data.leads).toHaveLength(1);
      expect(data.leads[0]).toMatchObject({ id: leadId, email });
      expect(data.leads[0]!.events.map((e) => e.type)).toEqual(['captured']);
      expect(data.leads[0]!.consents).toHaveLength(1);
      expect((await exportSubject(db, {})).leads).toEqual([]);
    });
  });
});
