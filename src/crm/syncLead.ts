import { UnrecoverableError, type Job } from 'bullmq';
import { asJson, type Db } from '../db.js';
import type { CrmSyncJob, JobQueue } from '../queue.js';
import { NOT_SYNCED, describeEvent } from './activity.js';
import type { CrmConfig } from './config.js';
import {
  CrmNotFoundError,
  CrmPermanentError,
  CrmRateLimitError,
  type CrmAdapter,
} from './types.js';

/**
 * Events are timestamped when their transaction starts, so one can commit after a later-
 * timestamped event was already synced. Only events older than this are synced, which is far
 * longer than any of our transactions.
 */
export const SYNC_LAG_MS = 10_000;
const BATCH_SIZE = 50;
const MAX_BATCHES_PER_JOB = 10;

export type SyncOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'up_to_date' }
  | { status: 'synced'; crmId: string; events: number; created: boolean };

export type SyncLead = (leadId: string) => Promise<SyncOutcome>;

/** Leads with events not yet pushed to the CRM (excluding dead-lettered ones). */
export async function findLeadsToSync(
  db: Db,
  {
    now = new Date(),
    syncDisqualified,
    limit = 500,
  }: { now?: Date; syncDisqualified: boolean; limit?: number },
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - SYNC_LAG_MS);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    WHERE l."crmSyncFailedAt" IS NULL
      AND (${syncDisqualified} OR l.tier IS DISTINCT FROM 'disqualified'::"LeadTier")
      AND EXISTS (
        SELECT 1 FROM "LeadEvent" e
        WHERE e."leadId" = l.id
          AND e."createdAt" <= ${cutoff}
          AND e.type NOT IN ('crm_synced', 'crm_sync_failed')
          AND (l."crmSyncedThrough" IS NULL
            OR (e."createdAt", e.id) > (l."crmSyncedThrough", l."crmSyncedEventId"))
      )
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

/**
 * Pushes a lead to the CRM: upserts the contact (assigning an owner when it's new), sets the
 * stage for its status, and logs every event not synced yet as an activity, advancing the
 * lead's cursor after each one so a retry doesn't log it twice.
 */
export function createSyncLead({
  db,
  crm,
  config,
  now = () => new Date(),
}: {
  db: Db;
  crm: CrmAdapter;
  config: CrmConfig;
  now?: () => Date;
}): SyncLead {
  return async function syncLead(leadId) {
    const lead = await db.lead.findUnique({ where: { id: leadId } });
    if (!lead) return { status: 'skipped', reason: 'lead not found' };
    if (lead.crmSyncFailedAt) return { status: 'skipped', reason: 'dead-lettered' };
    if (!config.syncDisqualified && lead.tier === 'disqualified') {
      return { status: 'skipped', reason: 'disqualified leads are not synced' };
    }

    const cutoff = new Date(now().getTime() - SYNC_LAG_MS);
    let crmId: string | null = null;
    let created = false;
    let synced = 0;
    // Position of the last event pushed, ordered by (createdAt, id).
    let through = lead.crmSyncedThrough;
    let throughId = lead.crmSyncedEventId ?? '';

    for (let batch = 0; batch < MAX_BATCHES_PER_JOB; batch++) {
      const events = await db.leadEvent.findMany({
        where: {
          leadId,
          createdAt: { lte: cutoff },
          type: { notIn: NOT_SYNCED },
          ...(through && {
            OR: [{ createdAt: { gt: through } }, { createdAt: through, id: { gt: throughId } }],
          }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: BATCH_SIZE,
      });
      if (events.length === 0) break;

      // Contact and stage once per job, before its activities.
      if (!crmId) {
        const contact = {
          email: lead.email,
          phone: lead.phone,
          firstName: lead.firstName,
          lastName: lead.lastName,
          company: lead.company,
        };
        try {
          crmId = await crm.upsertContact(contact, lead.crmId);
        } catch (err) {
          // Deleted or merged away in the CRM: create it again.
          if (!(err instanceof CrmNotFoundError && lead.crmId)) throw err;
          crmId = await crm.upsertContact(contact, null);
        }
        if (crmId !== lead.crmId) {
          created = !lead.crmId;
          const owner =
            lead.tier && lead.tier !== 'disqualified' ? config.owners[lead.tier] : undefined;
          if (owner) await crm.assignOwner(crmId, owner);
          await db.$transaction([
            db.lead.update({ where: { id: leadId }, data: { crmId } }),
            db.leadEvent.create({
              data: {
                leadId,
                type: 'crm_synced',
                payload: asJson({ crmId, provider: crm.provider, replaced: lead.crmId, owner }),
              },
            }),
          ]);
        }
        await crm.updateStage(crmId, config.stages[lead.status]);
      }

      for (const event of events) {
        await crm.logActivity(crmId, describeEvent(event));
        await db.lead.update({
          where: { id: leadId },
          data: { crmSyncedThrough: event.createdAt, crmSyncedEventId: event.id },
        });
        through = event.createdAt;
        throughId = event.id;
        synced++;
      }
      if (events.length < BATCH_SIZE) break;
    }

    if (!crmId) return { status: 'up_to_date' };
    return { status: 'synced', crmId, events: synced, created };
  };
}

/**
 * Parks a lead whose sync keeps failing: flags it so the sweep skips it, records
 * `crm_sync_failed`, and adds it to the dead-letter queue for inspection and requeueing.
 */
export async function deadLetterCrmSync(
  db: Db,
  queue: Pick<JobQueue, 'deadLetterCrmSync'>,
  leadId: string,
  err: unknown,
) {
  const error = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  const failedAt = new Date();
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true } });
  if (lead) {
    await db.$transaction([
      db.lead.update({
        where: { id: leadId },
        data: { crmSyncFailedAt: failedAt, crmSyncError: error },
      }),
      db.leadEvent.create({
        data: { leadId, type: 'crm_sync_failed', payload: asJson({ error }) },
      }),
    ]);
  }
  await queue.deadLetterCrmSync({ leadId, error, failedAt: failedAt.toISOString() });
}

/** Clears dead-lettered leads so the sweep syncs them again. Returns how many were cleared. */
export async function requeueDeadLetters(
  db: Db,
  queue: Pick<JobQueue, 'enqueueCrmSync' | 'clearCrmDeadLetters'>,
  leadIds?: string[],
): Promise<number> {
  const { count } = await db.lead.updateMany({
    where: { crmSyncFailedAt: { not: null }, ...(leadIds && { id: { in: leadIds } }) },
    data: { crmSyncFailedAt: null, crmSyncError: null },
  });
  await queue.clearCrmDeadLetters(leadIds);
  // Specific leads go right away; otherwise the next sweep picks them all up.
  for (const leadId of leadIds ?? []) await queue.enqueueCrmSync({ leadId });
  return count;
}

export interface CrmJobHooks {
  deadLetter(leadId: string, err: unknown): Promise<void>;
  /** Pauses the whole queue (BullMQ `worker.rateLimit`); the job is retried afterwards. */
  rateLimit(ms: number): Promise<Error>;
}

/**
 * Runs a `crm.sync` job: a 429 pauses the queue without using up an attempt; a permanent
 * error or the last failed attempt dead-letters the lead.
 */
export async function runCrmSyncJob(
  syncLead: SyncLead,
  job: Pick<Job<CrmSyncJob>, 'data' | 'attemptsMade' | 'opts'>,
  hooks: CrmJobHooks,
): Promise<SyncOutcome> {
  try {
    return await syncLead(job.data.leadId);
  } catch (err) {
    if (err instanceof CrmRateLimitError) throw await hooks.rateLimit(err.retryAfterMs);
    const final =
      err instanceof CrmPermanentError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (!final) throw err;
    await hooks.deadLetter(job.data.leadId, err);
    throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
  }
}
