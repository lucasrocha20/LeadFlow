import type { Db } from '../db.js';
import type { LeadStatus, LeadTier, Prisma } from '../generated/prisma/client.js';

export interface LeadFilters {
  status?: LeadStatus[];
  tier?: LeadTier[];
  source?: string;
  /** Case-insensitive match on name, email, phone or company. */
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  /** Only leads whose CRM sync is dead-lettered. */
  crmSyncFailed?: boolean;
  limit: number;
  /** From the previous page's `nextCursor`. */
  cursor?: string;
}

const summary = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  company: true,
  source: true,
  score: true,
  tier: true,
  status: true,
  crmId: true,
  crmSyncFailedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LeadSelect;

// Newest first, keyset-paginated on (createdAt, id) so pages stay stable as leads arrive.
const encodeCursor = (lead: { createdAt: Date; id: string }) =>
  Buffer.from(`${lead.createdAt.toISOString()}|${lead.id}`).toString('base64url');

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}

export class InvalidCursorError extends Error {}

export async function listLeads(db: Db, filters: LeadFilters) {
  const after = filters.cursor ? decodeCursor(filters.cursor) : undefined;
  if (after === null) throw new InvalidCursorError('Invalid cursor');
  const q = filters.q?.trim();

  const where: Prisma.LeadWhereInput = {
    ...(filters.status && { status: { in: filters.status } }),
    ...(filters.tier && { tier: { in: filters.tier } }),
    ...(filters.source && { source: filters.source }),
    ...((filters.createdFrom || filters.createdTo) && {
      createdAt: { gte: filters.createdFrom, lt: filters.createdTo },
    }),
    ...(filters.crmSyncFailed !== undefined && {
      crmSyncFailedAt: filters.crmSyncFailed ? { not: null } : null,
    }),
    AND: [
      q
        ? {
            OR: (['firstName', 'lastName', 'email', 'phone', 'company'] as const).map((f) => ({
              [f]: { contains: q, mode: 'insensitive' as const },
            })),
          }
        : {},
      after
        ? {
            OR: [
              { createdAt: { lt: after.createdAt } },
              { createdAt: after.createdAt, id: { lt: after.id } },
            ],
          }
        : {},
    ],
  };

  const rows = await db.lead.findMany({
    where,
    select: summary,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: filters.limit + 1,
  });
  const leads = rows.slice(0, filters.limit);
  const last = leads.at(-1);
  return {
    leads,
    nextCursor: rows.length > filters.limit && last ? encodeCursor(last) : null,
  };
}

const MAX_TIMELINE_EVENTS = 1000;

/** A lead with its enrollments and its event timeline (oldest first). */
export async function getLead(db: Db, leadId: string) {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: {
      enrollments: {
        orderBy: { createdAt: 'asc' },
        include: { sequence: { select: { name: true, tier: true } } },
      },
    },
  });
  if (!lead) return null;

  // Newest N, returned oldest first; events in one transaction share createdAt, so id breaks ties.
  const newest = await db.leadEvent.findMany({
    where: { leadId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_TIMELINE_EVENTS + 1,
  });
  const truncated = newest.length > MAX_TIMELINE_EVENTS;
  const events = newest.slice(0, MAX_TIMELINE_EVENTS).reverse();

  const { enrollments, ...rest } = lead;
  return {
    lead: rest,
    enrollments: enrollments.map(({ sequence, ...enrollment }) => ({
      ...enrollment,
      sequence: sequence.name,
      sequenceTier: sequence.tier,
    })),
    timeline: { events, truncated },
  };
}
