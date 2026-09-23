import type { Db } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';

export interface MetricsRange {
  from: Date;
  to: Date;
  source?: string;
}

interface DurationStats {
  leads: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  avgSeconds: number | null;
}

interface Funnel {
  leads: number;
  contacted: number;
  replied: number;
  converted: number;
  conversionRate: number | null;
}

const rate = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null;

/**
 * Operational metrics. The funnel metrics (time to first contact, reply rate per step,
 * conversion) cover the cohort of leads *captured* in the range, so recent cohorts keep
 * improving as they age. Send failures are counted by when they happened.
 */
export async function computeMetrics(db: Db, range: MetricsRange) {
  // Leads captured in the range (optionally from one source).
  const cohort = Prisma.sql`
    SELECT l.id, l."createdAt", l.tier, l.source, l.status FROM "Lead" l
    WHERE l."createdAt" >= ${range.from} AND l."createdAt" < ${range.to}
    ${range.source ? Prisma.sql`AND l.source = ${range.source}` : Prisma.empty}`;

  const [ttfc, steps, funnels, sends, errors] = await Promise.all([
    db.$queryRaw<
      {
        tier: string | null;
        overall: boolean;
        leads: number;
        median: number | null;
        p90: number | null;
        avg: number | null;
      }[]
    >`
      WITH cohort AS (${cohort}),
      first_contact AS (
        SELECT c.id, c.tier,
          EXTRACT(EPOCH FROM (min(e."createdAt") - c."createdAt"))::float8 AS seconds
        FROM cohort c JOIN "LeadEvent" e ON e."leadId" = c.id
        WHERE e.type = 'message_sent' AND e.payload->>'kind' = 'first_contact'
        GROUP BY c.id, c.tier, c."createdAt"
      )
      SELECT tier::text, GROUPING(tier) = 1 AS overall, count(*)::int AS leads,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS median,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY seconds) AS p90,
        avg(seconds)::float8 AS avg
      FROM first_contact GROUP BY ROLLUP (tier)`,

    // Each lead's touches (first contact, then each follow-up step) in order. A touch counts
    // as replied when the lead replied after it and before the next touch.
    db.$queryRaw<
      {
        sequence: string | null;
        step: number | null;
        sent: number;
        replied: number;
        optedOut: number;
      }[]
    >`
      WITH cohort AS (${cohort}),
      touches AS (
        SELECT e."leadId",
          CASE WHEN e.payload->>'kind' = 'follow_up' THEN s.name END AS sequence,
          -- Follow-up messages are keyed "follow-up:<enrollmentId>:<step>" (followUpKey).
          CASE WHEN e."dedupeKey" ~ '^follow-up:[^:]+:[0-9]+$'
            THEN split_part(e."dedupeKey", ':', 3)::int END AS step,
          min(e."createdAt") AS sent_at
        FROM "LeadEvent" e
        JOIN cohort c ON c.id = e."leadId"
        LEFT JOIN "Enrollment" en ON en.id = e.payload->>'enrollmentId'
        LEFT JOIN "Sequence" s ON s.id = en."sequenceId"
        WHERE e.type = 'message_sent' AND e.payload->>'kind' IN ('first_contact', 'follow_up')
        GROUP BY 1, 2, 3
      ),
      windows AS (
        SELECT t.*, lead(sent_at) OVER (PARTITION BY "leadId" ORDER BY sent_at) AS next_at
        FROM touches t
      )
      SELECT w.sequence, w.step, count(*)::int AS sent,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM "LeadEvent" r
          WHERE r."leadId" = w."leadId" AND r.type = 'reply_received'
            AND coalesce((r.payload->>'optOut')::boolean, false) = false
            AND r."createdAt" >= w.sent_at AND (w.next_at IS NULL OR r."createdAt" < w.next_at)
        ))::int AS replied,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM "LeadEvent" r
          WHERE r."leadId" = w."leadId" AND r.type = 'opted_out'
            AND r."createdAt" >= w.sent_at AND (w.next_at IS NULL OR r."createdAt" < w.next_at)
        ))::int AS "optedOut"
      FROM windows w
      GROUP BY w.sequence, w.step
      ORDER BY w.sequence NULLS FIRST, w.step NULLS FIRST`,

    db.$queryRaw<
      {
        source: string | null;
        tier: string | null;
        by: 'source' | 'tier' | 'all';
        leads: number;
        contacted: number;
        replied: number;
        converted: number;
      }[]
    >`
      WITH cohort AS (${cohort})
      SELECT c.source, coalesce(c.tier::text, 'unscored') AS tier,
        CASE WHEN GROUPING(c.source) = 0 THEN 'source'
             WHEN GROUPING(coalesce(c.tier::text, 'unscored')) = 0 THEN 'tier'
             ELSE 'all' END AS by,
        count(*)::int AS leads,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM "LeadEvent" e WHERE e."leadId" = c.id
            AND e.type = 'message_sent' AND e.payload->>'kind' = 'first_contact'
        ))::int AS contacted,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM "LeadEvent" e WHERE e."leadId" = c.id AND e.type = 'reply_received'
            AND coalesce((e.payload->>'optOut')::boolean, false) = false
        ))::int AS replied,
        count(*) FILTER (WHERE c.status = 'converted')::int AS converted
      FROM cohort c
      GROUP BY GROUPING SETS ((c.source), (coalesce(c.tier::text, 'unscored')), ())`,

    // Sends are counted when they happened, not by cohort. `message_failed` is only recorded
    // once a message is given up on (permanent error or retries exhausted).
    db.$queryRaw<
      { channel: string; kind: string; sent: number; failed: number; permanent: number }[]
    >`
      SELECT e.channel::text AS channel, coalesce(e.payload->>'kind', 'unknown') AS kind,
        count(*) FILTER (WHERE e.type IN ('message_sent', 'rep_notified'))::int AS sent,
        count(*) FILTER (WHERE e.type = 'message_failed')::int AS failed,
        count(*) FILTER (WHERE e.type = 'message_failed'
          AND coalesce((e.payload->>'permanent')::boolean, false))::int AS permanent
      FROM "LeadEvent" e JOIN "Lead" l ON l.id = e."leadId"
      WHERE e.type IN ('message_sent', 'rep_notified', 'message_failed')
        AND e."createdAt" >= ${range.from} AND e."createdAt" < ${range.to}
        ${range.source ? Prisma.sql`AND l.source = ${range.source}` : Prisma.empty}
      GROUP BY 1, 2 ORDER BY 1, 2`,

    db.$queryRaw<{ channel: string; error: string; count: number; lastAt: Date }[]>`
      SELECT e.channel::text AS channel, left(coalesce(e.payload->>'error', ''), 300) AS error,
        count(*)::int AS count, max(e."createdAt") AS "lastAt"
      FROM "LeadEvent" e JOIN "Lead" l ON l.id = e."leadId"
      WHERE e.type = 'message_failed'
        AND e."createdAt" >= ${range.from} AND e."createdAt" < ${range.to}
        ${range.source ? Prisma.sql`AND l.source = ${range.source}` : Prisma.empty}
      GROUP BY 1, 2 ORDER BY count(*) DESC, max(e."createdAt") DESC LIMIT 10`,
  ]);

  const duration = (row: (typeof ttfc)[number] | undefined): DurationStats => ({
    leads: row?.leads ?? 0,
    medianSeconds: row?.median ?? null,
    p90Seconds: row?.p90 ?? null,
    avgSeconds: row?.avg ?? null,
  });
  const funnel = ({ leads, contacted, replied, converted }: (typeof funnels)[number]): Funnel => ({
    leads,
    contacted,
    replied,
    converted,
    conversionRate: rate(converted, leads),
  });
  const overall = funnels.find((f) => f.by === 'all');

  return {
    range: { from: range.from, to: range.to, source: range.source ?? null },
    timeToFirstContact: {
      overall: duration(ttfc.find((r) => r.overall)),
      byTier: Object.fromEntries(
        ttfc.filter((r) => !r.overall).map((r) => [r.tier ?? 'unscored', duration(r)]),
      ),
    },
    replyRateByStep: steps.map((s) => ({
      touch: s.sequence === null ? 'first_contact' : 'follow_up',
      sequence: s.sequence,
      step: s.step,
      sent: s.sent,
      replied: s.replied,
      optedOut: s.optedOut,
      replyRate: rate(s.replied, s.sent),
    })),
    conversion: {
      overall: overall
        ? funnel(overall)
        : { leads: 0, contacted: 0, replied: 0, converted: 0, conversionRate: null },
      bySource: funnels
        .filter((f) => f.by === 'source')
        .map((f) => ({ source: f.source, ...funnel(f) })),
      byTier: funnels.filter((f) => f.by === 'tier').map((f) => ({ tier: f.tier, ...funnel(f) })),
    },
    sends: {
      byChannel: sends.map((s) => ({
        channel: s.channel,
        kind: s.kind,
        sent: s.sent,
        failed: s.failed,
        permanentFailures: s.permanent,
        failureRate: rate(s.failed, s.sent + s.failed),
      })),
      topErrors: errors,
    },
  };
}

export type Metrics = Awaited<ReturnType<typeof computeMetrics>>;
