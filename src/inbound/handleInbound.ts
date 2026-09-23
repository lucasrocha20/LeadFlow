import { asJson, isUniqueViolation, type Db } from '../db.js';
import type { Lead, LeadStatus } from '../generated/prisma/client.js';
import { stopEnrollments } from '../followup/enrollment.js';
import type { JobQueue } from '../queue.js';
import { isOptOut, optOutInTx } from './optOut.js';
import type { InboundMessage } from './types.js';

export type InboundOutcome =
  | { status: 'unmatched' }
  | { status: 'duplicate' }
  | { status: 'opted_out'; leadId: string }
  | { status: 'replied'; leadId: string; engaged: boolean; stoppedSequences: number };

export type HandleInbound = (message: InboundMessage) => Promise<InboundOutcome>;

// A reply makes these leads `engaged`. Others (converted, do_not_contact…) keep their status.
const ENGAGEABLE: LeadStatus[] = ['new', 'qualified', 'contacted', 'unresponsive'];

export interface HandleInboundDeps {
  db: Db;
  queue: Pick<JobQueue, 'enqueueSendMessage'>;
  optOutKeywords: readonly string[];
  /** Rep alert when a lead starts engaging; skipped unless both are set. */
  salesAlertEmail?: string;
  repAlertTemplate?: string;
}

/**
 * A lead replied: record it, and either opt the lead out (STOP…) or stop its follow-up
 * sequences, mark it `engaged` and alert the rep. Idempotent per provider message id.
 */
export function createHandleInbound({
  db,
  queue,
  optOutKeywords,
  salesAlertEmail,
  repAlertTemplate,
}: HandleInboundDeps): HandleInbound {
  async function findLead(message: InboundMessage): Promise<Lead | null> {
    // Same rule as capture: the oldest lead with this address.
    const where = message.channel === 'email' ? { email: message.from } : { phone: message.from };
    return db.lead.findFirst({ where, orderBy: { createdAt: 'asc' } });
  }

  // Tell the rep once the lead starts engaging (later replies only get recorded).
  async function alertRep(leadId: string, replyEventId: string, message: InboundMessage) {
    if (!salesAlertEmail || !repAlertTemplate) return;
    await queue.enqueueSendMessage({
      leadId,
      kind: 'rep_alert',
      channel: 'email',
      template: repAlertTemplate,
      to: salesAlertEmail,
      dedupeKey: `rep-reply:${replyEventId}`,
      vars: {
        replyChannel: message.channel,
        replyText: message.text.slice(0, 1000) || message.subject || '(no text)',
      },
    });
  }

  async function duplicateOf(dedupeKey: string, message: InboundMessage) {
    const event = await db.leadEvent.findUnique({ where: { dedupeKey } });
    // Queue the alert again in case that failed the first time; its job id dedupes it.
    if (event && (event.payload as { engaged?: boolean } | null)?.engaged) {
      await alertRep(event.leadId, event.id, message);
    }
    return { status: 'duplicate' as const };
  }

  return async function handleInbound(message) {
    const dedupeKey = `reply:${message.channel}:${message.externalId}`;
    if (await db.leadEvent.findUnique({ where: { dedupeKey } })) {
      return duplicateOf(dedupeKey, message);
    }

    const match = await findLead(message);
    if (!match) return { status: 'unmatched' };
    const optingOut = isOptOut(message, optOutKeywords);

    let outcome: InboundOutcome;
    let alertEventId: string | null = null;
    try {
      outcome = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "Lead" WHERE id = ${match.id} FOR UPDATE`;
        const lead = await tx.lead.findUniqueOrThrow({ where: { id: match.id } });
        const engaged = !optingOut && ENGAGEABLE.includes(lead.status);
        const event = await tx.leadEvent.create({
          data: {
            leadId: lead.id,
            type: 'reply_received',
            channel: message.channel,
            dedupeKey,
            payload: asJson({
              from: message.from,
              text: message.text.slice(0, 4000),
              subject: message.subject,
              externalId: message.externalId,
              receivedAt: message.receivedAt.toISOString(),
              optOut: optingOut,
              engaged,
            }),
          },
        });

        if (optingOut) {
          await optOutInTx(tx, lead, 'reply');
          return { status: 'opted_out' as const, leadId: lead.id };
        }

        const stoppedSequences = await stopEnrollments(tx, lead.id, 'replied');
        if (engaged) {
          await tx.lead.update({ where: { id: lead.id }, data: { status: 'engaged' } });
          alertEventId = event.id;
        }
        return { status: 'replied' as const, leadId: lead.id, engaged, stoppedSequences };
      });
    } catch (err) {
      // The same provider message was processed concurrently.
      if (isUniqueViolation(err)) return duplicateOf(dedupeKey, message);
      throw err;
    }

    if (alertEventId) await alertRep(match.id, alertEventId, message);
    return outcome;
  };
}
