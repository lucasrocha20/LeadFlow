import { asJson, isUniqueViolation, type Db } from '../db.js';
import type { LeadStatus } from '../generated/prisma/client.js';
import type { JobQueue, LeadCapturedJob } from '../queue.js';
import { scoreLead, type ScoreResult } from './engine.js';
import type { ScoringRules } from './rules.js';

export interface QualifyResult extends ScoreResult {
  leadId: string;
  eventId: string;
  /** This capture was already scored (job retry); nothing was written. */
  duplicate: boolean;
}

export type QualifyLead = (job: LeadCapturedJob) => Promise<QualifyResult | null>;

// Scoring may only move a lead between these statuses. Once it has been contacted, opted out,
// etc., a re-submission updates its score and tier but leaves the status alone.
const PRE_CONTACT: LeadStatus[] = ['new', 'qualified', 'disqualified'];

export function createQualifyLead(db: Db, queue: JobQueue, rules: ScoringRules): QualifyLead {
  async function findScored(dedupeKey: string) {
    return db.leadEvent.findUnique({ where: { dedupeKey } });
  }

  async function enqueueNext(result: QualifyResult) {
    if (result.tier === 'disqualified') return;
    await queue.enqueueLeadQualified({
      leadId: result.leadId,
      eventId: result.eventId,
      score: result.score,
      tier: result.tier,
    });
  }

  async function duplicateOf(event: { id: string; leadId: string; payload: unknown }) {
    const { score, tier, matchedRules, disqualifiedBy } = event.payload as ScoreResult;
    const result: QualifyResult = {
      leadId: event.leadId,
      eventId: event.id,
      score,
      tier,
      matchedRules,
      disqualifiedBy,
      duplicate: true,
    };
    // Re-enqueue in case the first attempt failed after the commit; the job id dedupes it.
    await enqueueNext(result);
    return result;
  }

  return async function qualifyLead({ leadId, eventId: capturedEventId }) {
    // One score per capture: a retried job finds this key and doesn't score again.
    const dedupeKey = `scored:${capturedEventId}`;

    const existing = await findScored(dedupeKey);
    if (existing) return duplicateOf(existing);

    let result: QualifyResult | null;
    try {
      result = await db.$transaction(async (tx) => {
        // Lock the lead so a concurrent capture (merge) or scoring can't interleave: whoever
        // scores last reads the latest data.
        await tx.$executeRaw`SELECT 1 FROM "Lead" WHERE id = ${leadId} FOR UPDATE`;
        const lead = await tx.lead.findUnique({ where: { id: leadId } });
        if (!lead) return null;

        const scored = scoreLead(lead, rules);
        const status: LeadStatus | undefined = PRE_CONTACT.includes(lead.status)
          ? scored.tier === 'disqualified'
            ? 'disqualified'
            : 'qualified'
          : undefined;

        await tx.lead.update({
          where: { id: leadId },
          data: { score: scored.score, tier: scored.tier, status },
        });
        const event = await tx.leadEvent.create({
          data: {
            leadId,
            type: 'scored',
            dedupeKey,
            payload: asJson({
              ...scored,
              capturedEventId,
              previous: { score: lead.score, tier: lead.tier, status: lead.status },
              status: status ?? lead.status,
            }),
          },
        });
        return { ...scored, leadId, eventId: event.id, duplicate: false };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const winner = await findScored(dedupeKey);
        if (winner) return duplicateOf(winner);
      }
      throw err;
    }

    // The lead was deleted after it was captured; nothing to do.
    if (!result) return null;

    await enqueueNext(result);
    return result;
  };
}
