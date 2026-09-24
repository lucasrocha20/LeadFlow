import { lockContactKeys } from '../capture/captureLead.js';
import type { CrmAdapter } from '../crm/types.js';
import type { Db } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';
import { addressHashes, suppress } from './suppression.js';

/** A data subject, by normalized address (lowercased email, E.164 phone). */
export interface Subject {
  email?: string | null;
  phone?: string | null;
}

function subjectWhere(subject: Subject): Prisma.LeadWhereInput | null {
  const or: Prisma.LeadWhereInput[] = [];
  if (subject.email) or.push({ email: subject.email });
  if (subject.phone) or.push({ phone: subject.phone });
  return or.length > 0 ? { OR: or } : null;
}

/** Everything LeadFlow holds about a person (LGPD art. 18 / GDPR art. 15 access requests). */
export async function exportSubject(db: Db, subject: Subject) {
  const where = subjectWhere(subject);
  const leads = where
    ? await db.lead.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: {
          events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          enrollments: { include: { sequence: { select: { name: true } } } },
          consents: { orderBy: { createdAt: 'asc' } },
        },
      })
    : [];
  const hashes = addressHashes(subject);
  const suppressed =
    hashes.length > 0 && (await db.suppression.count({ where: { hash: { in: hashes } } })) > 0;
  return { generatedAt: new Date(), subject, suppressed, leads };
}

export async function findSubjectLeadIds(db: Db, subject: Subject): Promise<string[]> {
  const where = subjectWhere(subject);
  if (!where) return [];
  const leads = await db.lead.findMany({ where, select: { id: true } });
  return leads.map((l) => l.id);
}

export type ErasureReason = 'request' | 'retention';

export interface ErasureResult {
  erased: number;
  crmDeleted: number;
  suppressed: number;
}

/**
 * Permanently deletes leads with their events, enrollments and consent records.
 *
 * - `request` (a data-subject erasure request): every address of the erased leads, plus
 *   `extraSubject`'s, goes on the suppression list, so the person is never contacted again
 *   even if they're captured again.
 * - `retention` (expired data): only addresses that had opted out are suppressed.
 *
 * With `crm`, the contacts are deleted from the CRM first. Their sync is parked beforehand so
 * it can't recreate them. If the CRM fails, nothing is erased here and a retry is safe.
 */
export async function eraseLeads(
  db: Db,
  leadIds: string[],
  {
    reason,
    crm,
    extraSubject,
  }: { reason: ErasureReason; crm?: CrmAdapter; extraSubject?: Subject },
): Promise<ErasureResult> {
  let crmDeleted = 0;
  if (crm) {
    const withCrm = await db.$transaction(async (tx) => {
      await tx.lead.updateMany({
        where: { id: { in: leadIds } },
        data: { crmSyncFailedAt: new Date(), crmSyncError: 'erasure in progress' },
      });
      return tx.lead.findMany({
        where: { id: { in: leadIds }, crmId: { not: null } },
        select: { crmId: true },
      });
    });
    for (const { crmId } of withCrm) {
      await crm.deleteContact(crmId!);
      crmDeleted++;
    }
  }

  return db.$transaction(async (tx) => {
    const load = () =>
      tx.lead.findMany({
        where: { id: { in: leadIds } },
        select: { id: true, email: true, phone: true, status: true },
      });
    // Same locks as capture: a submission arriving meanwhile waits, then sees the suppression.
    // Re-read after locking, in case a capture added an address in between.
    await lockContactKeys(tx, ...(await load()), ...(extraSubject ? [extraSubject] : []));
    const found = await load();

    const subjectHashes = [
      ...new Set([
        ...found.flatMap((lead) => addressHashes(lead)),
        ...(extraSubject ? addressHashes(extraSubject) : []),
      ]),
    ];
    const suppressed =
      reason === 'request'
        ? await suppress(tx, subjectHashes, 'erasure_request')
        : await suppress(
            tx,
            found.filter((l) => l.status === 'do_not_contact').flatMap((l) => addressHashes(l)),
            'opted_out',
          );

    const { count } = await tx.lead.deleteMany({ where: { id: { in: found.map((l) => l.id) } } });
    if (count > 0 || reason === 'request') {
      await tx.erasure.create({
        data: {
          reason,
          leadCount: count,
          crmDeleted,
          // Proof that a request was fulfilled; not needed for routine retention.
          subjectHashes: reason === 'request' ? subjectHashes : [],
        },
      });
    }
    return { erased: count, crmDeleted, suppressed };
  });
}

/**
 * Leads with no activity since `cutoff` (no event, no update) and no follow-up in progress,
 * oldest first: the candidates for retention erasure.
 */
export async function findExpiredLeads(db: Db, cutoff: Date, limit = 500): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    WHERE l."updatedAt" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "LeadEvent" e WHERE e."leadId" = l.id AND e."createdAt" >= ${cutoff}
      )
      AND NOT EXISTS (
        SELECT 1 FROM "Enrollment" en
        WHERE en."leadId" = l.id AND en.status IN ('active', 'paused')
      )
    ORDER BY l."updatedAt" ASC
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}
