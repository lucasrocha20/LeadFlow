// End to end, from form webhook to CRM: the real API (createApi) and background pipeline
// (startPipeline) against Postgres and Redis, with dry-run messaging and a recording CRM.
// Uses the shipped config files and the seeded templates/sequences (`npm run db:seed`), and
// its own BullMQ prefix, so a running dev worker never picks up its jobs.
// Run with `npm run test:db`; skipped unless DATABASE_URL and REDIS_URL are set.
import { randomInt, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../../src/api.js';
import { WEBSITE_SECRET_HEADER } from '../../src/capture/adapters/website.js';
import { loadConfig, type Config } from '../../src/config.js';
import {
  loadContactConfig,
  referencedTemplates,
  type ContactConfig,
} from '../../src/contact/config.js';
import { loadCrmConfig, type CrmConfig } from '../../src/crm/config.js';
import { SYNC_LAG_MS } from '../../src/crm/syncLead.js';
import type { CrmActivity, CrmAdapter } from '../../src/crm/types.js';
import { createDb } from '../../src/db.js';
import { REPLY_SECRET_HEADER } from '../../src/inbound/adapters/email.js';
import { startPipeline, type Pipeline } from '../../src/pipeline.js';
import { addressHashes } from '../../src/privacy/suppression.js';
import { loadScoringRules } from '../../src/qualification/rules.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];

/** Records what would reach the CRM. */
function recordingCrm() {
  const contacts = new Map<string, { activities: CrmActivity[]; stage: Record<string, string> }>();
  const deleted: string[] = [];
  const crm: CrmAdapter = {
    provider: 'recording',
    async upsertContact(_contact, crmId) {
      const id = crmId ?? `crm-${randomUUID()}`;
      if (!contacts.has(id)) contacts.set(id, { activities: [], stage: {} });
      return id;
    },
    async updateStage(crmId, stage) {
      Object.assign(contacts.get(crmId)!.stage, stage);
    },
    async assignOwner() {},
    async logActivity(crmId, activity) {
      contacts.get(crmId)!.activities.push(activity);
    },
    async deleteContact(crmId) {
      contacts.delete(crmId);
      deleted.push(crmId);
    },
  };
  return { crm, contacts, deleted };
}

async function waitFor<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!databaseUrl || !redisUrl)(
  'end to end: form → contact → reply → CRM → erasure',
  () => {
    const prefix = `leadflow-e2e-${randomUUID().slice(0, 8)}`;
    const adminToken = 'e2e-admin-token-'.padEnd(32, 'x');
    // Built in beforeAll: vitest still runs this body to collect a skipped suite, and this
    // must neither validate config nor open connections when there's no database.
    const loadTestConfig = () =>
      loadConfig({
        ...process.env,
        NODE_ENV: 'test',
        FORM_WEBHOOK_SECRET: 'e2e-form-secret',
        REPLY_WEBHOOK_SECRET: 'e2e-reply-secret',
        SALES_ALERT_EMAIL: 'sales@example.com',
        MESSAGING_PROVIDER: 'dry-run',
        EMAIL_PROVIDER: 'dry-run',
        CRM_PROVIDER: 'dry-run',
        ADMIN_TOKEN: adminToken,
        RATE_LIMIT_PER_MINUTE: '0',
        DATA_RETENTION_DAYS: '',
        PUBLIC_BASE_URL: '',
        UNSUBSCRIBE_SECRET: '',
      });
    let config: Config;
    let contactConfig: ContactConfig;
    let crmConfig: CrmConfig;
    const db = createDb(databaseUrl ?? '');
    const redis = new Redis(redisUrl ?? '', { enableOfflineQueue: false, lazyConnect: true });
    const workerConnection = new Redis(redisUrl ?? '', {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    const { crm, contacts, deleted } = recordingCrm();

    // A new person each run: a business email (scores as hot with the budget below).
    const email = `e2e-${randomUUID().slice(0, 8)}@acme-industries.com`;
    const phone = `+55119${String(randomInt(10_000_000, 99_999_999))}`;
    const submission = (submissionId: string) => ({
      submissionId,
      name: 'Ana Souza',
      email,
      phone,
      company: 'Acme Industries',
      consentEmail: true,
      consentMessaging: true,
      consent: { text: 'I agree to be contacted about my request.', version: 'e2e-1' },
      fields: { budget: 20000, company_size: '50-200' },
    });

    let api: Awaited<ReturnType<typeof createApi>>;
    let pipeline: Pipeline;

    beforeAll(async () => {
      config = loadTestConfig();
      // The shipped config, minus quiet hours so the result doesn't depend on the time of day.
      const shipped = loadContactConfig(config.CONTACT_CONFIG_PATH);
      contactConfig = { ...shipped, quietHours: { ...shipped.quietHours, channels: [] } };
      crmConfig = loadCrmConfig(config.CRM_CONFIG_PATH);
      const expected = [...referencedTemplates(contactConfig).keys()];
      const found = await db.template.count({ where: { name: { in: expected } } });
      if (found !== expected.length) {
        throw new Error('Default templates missing: run `npm run db:seed` first');
      }
      await redis.connect();
      await workerConnection.connect();
      api = await createApi({ config, db, contactConfig, crmConfig, redis, prefix, crm });
      pipeline = startPipeline({
        config,
        db,
        log: pino({ enabled: false }),
        rules: loadScoringRules(config.SCORING_RULES_PATH),
        contactConfig,
        crmConfig,
        redis,
        workerConnection,
        prefix,
        crm,
        // Past the sync lag, so the sweep picks up events right away.
        crmNow: () => new Date(Date.now() + SYNC_LAG_MS + 1_000),
        intervals: false,
      });
    });

    afterAll(async () => {
      await pipeline?.close();
      await api?.close();
      await db.lead.deleteMany({ where: { OR: [{ email }, { phone }] } });
      const hashes = addressHashes({ email, phone });
      await db.suppression.deleteMany({ where: { hash: { in: hashes } } });
      await db.erasure.deleteMany({ where: { subjectHashes: { hasSome: hashes } } });
      // Drop this run's queues.
      let cursor = '0';
      do {
        const [next, keys] = await workerConnection.scan(
          cursor,
          'MATCH',
          `${prefix}:*`,
          'COUNT',
          500,
        );
        cursor = next;
        if (keys.length > 0) await workerConnection.del(...keys);
      } while (cursor !== '0');
      redis.disconnect();
      workerConnection.disconnect();
      await db.$disconnect();
    });

    const events = (leadId: string) =>
      db.leadEvent.findMany({ where: { leadId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

    it('runs a hot lead through the whole lifecycle', { timeout: 60_000 }, async () => {
      // 1. Capture: a signed website submission.
      const captured = await api.app.inject({
        method: 'POST',
        url: '/webhooks/forms/website',
        headers: { [WEBSITE_SECRET_HEADER]: 'e2e-form-secret' },
        payload: submission(`e2e-${randomUUID()}`),
      });
      expect(captured.statusCode).toBe(200);
      const { leadId } = captured.json() as { leadId: string };

      // 2–3. Qualification and first contact: hot, contacted on both channels, rep alerted,
      // enrolled in the hot sequence.
      const contacted = await waitFor('first contact on both channels and enrollment', async () => {
        const list = await events(leadId);
        const firstContacts = list.filter(
          (e) =>
            e.type === 'message_sent' && (e.payload as { kind?: string }).kind === 'first_contact',
        );
        return firstContacts.length === 2 && list.some((e) => e.type === 'enrolled') && list;
      });
      const lead = await db.lead.findUniqueOrThrow({
        where: { id: leadId },
        include: { enrollments: true, consents: true },
      });
      expect(lead).toMatchObject({ tier: 'hot', status: 'contacted', email, phone });
      expect(
        new Set(contacted.filter((e) => e.type === 'message_sent').map((e) => e.channel)),
      ).toEqual(new Set(['email', 'whatsapp']));
      expect(lead.enrollments).toEqual([
        expect.objectContaining({ status: 'active', currentStep: 1 }),
      ]);
      // Consent evidence landed in the ledger.
      expect(lead.consents.map((c) => [c.purpose, c.granted, c.source]).sort()).toEqual([
        ['email', true, 'website'],
        ['messaging', true, 'website'],
      ]);
      expect(lead.consents[0]!.evidence).toMatchObject({ version: 'e2e-1' });
      await waitFor('hot-lead rep alert', async () =>
        (await events(leadId)).some((e) => e.type === 'rep_notified'),
      );

      // 4. The lead replies by email: engaged, follow-up stopped, rep alerted again.
      const replied = await api.app.inject({
        method: 'POST',
        url: '/webhooks/replies/email',
        headers: { [REPLY_SECRET_HEADER]: 'e2e-reply-secret' },
        payload: {
          from: `Ana Souza <${email}>`,
          subject: 'Re: your request',
          text: 'Yes, let us talk on Thursday.',
          messageId: `<${randomUUID()}@mail.example.com>`,
        },
      });
      expect(replied.statusCode).toBe(200);
      await waitFor('engaged, sequence stopped, second rep alert', async () => {
        const current = await db.lead.findUniqueOrThrow({
          where: { id: leadId },
          include: { enrollments: true },
        });
        const alerts = (await events(leadId)).filter((e) => e.type === 'rep_notified');
        return (
          current.status === 'engaged' &&
          current.enrollments[0]?.status === 'stopped' &&
          alerts.length === 2
        );
      });

      // 5. CRM sync: the contact and its whole timeline.
      expect(await pipeline.crmSweep()).toBeGreaterThanOrEqual(1);
      const synced = await waitFor('CRM sync of every event', async () => {
        const current = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
        const list = await events(leadId);
        const lastSyncable = list
          .filter((e) => !['crm_synced', 'crm_sync_failed'].includes(e.type))
          .at(-1);
        return current.crmId && current.crmSyncedEventId === lastSyncable?.id ? current : null;
      });
      const contact = contacts.get(synced.crmId!)!;
      const titles = contact.activities.map((a) => a.title);
      expect(titles[0]).toBe('LeadFlow: Lead captured from website');
      expect(titles).toContainEqual(expect.stringMatching(/^LeadFlow: Scored \d+ → hot$/));
      expect(titles).toContain('LeadFlow: Reply received on Email');
      expect(titles).toContain('LeadFlow: Follow-up hot_follow_up stopped');
      // Synced after the reply, so the CRM shows the engaged stage.
      expect(contact.stage).toEqual(crmConfig.stages.engaged);

      // 6. Erasure request: gone from LeadFlow and the CRM, and the addresses are suppressed.
      const erase = await api.app.inject({
        method: 'POST',
        url: '/admin/api/privacy/erase',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { email: email.toUpperCase(), deleteFromCrm: true, confirm: true },
      });
      expect(erase.json()).toEqual({ erased: 1, crmDeleted: 1, suppressed: 2 });
      expect(deleted).toEqual([synced.crmId]);
      expect(await db.lead.findUnique({ where: { id: leadId } })).toBeNull();
      expect(await db.leadEvent.count({ where: { leadId } })).toBe(0);
      expect(await db.consentRecord.count({ where: { leadId } })).toBe(0);

      // 7. The same person submits the form again: captured, but never contacted.
      const again = await api.app.inject({
        method: 'POST',
        url: '/webhooks/forms/website',
        headers: { [WEBSITE_SECRET_HEADER]: 'e2e-form-secret' },
        payload: submission(`e2e-${randomUUID()}`),
      });
      const { leadId: newLeadId } = again.json() as { leadId: string };
      expect(newLeadId).not.toBe(leadId);
      await waitFor('the new lead to be scored and planned', async () =>
        (await events(newLeadId)).some((e) => e.type === 'scored'),
      );
      const blocked = await db.lead.findUniqueOrThrow({ where: { id: newLeadId } });
      expect(blocked).toMatchObject({
        status: 'do_not_contact',
        consentEmail: false,
        consentMessaging: false,
      });
      // Give queued jobs a moment; nothing may go out.
      await new Promise((r) => setTimeout(r, 1_000));
      const after = await events(newLeadId);
      expect(after.find((e) => e.type === 'opted_out')?.payload).toMatchObject({
        source: 'suppression_list',
      });
      expect(after.filter((e) => e.type === 'message_sent' || e.type === 'rep_notified')).toEqual(
        [],
      );
    });
  },
);
