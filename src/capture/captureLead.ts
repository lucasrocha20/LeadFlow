import { asJson, isUniqueViolation, type Db } from '../db.js';
import { Prisma, type Lead } from '../generated/prisma/client.js';
import type { JobQueue } from '../queue.js';
import type { LeadInput } from './types.js';

export interface CaptureRequest {
  source: string;
  input: LeadInput;
  rawPayload: unknown;
}

export interface CaptureResult {
  leadId: string;
  eventId: string;
  /** The submission was already captured (webhook replay); nothing was written. */
  duplicate: boolean;
}

export type CaptureLead = (req: CaptureRequest) => Promise<CaptureResult>;

type Tx = Prisma.TransactionClient;

/**
 * Serializes captures that share an email or phone, so two concurrent submissions from
 * the same person can't both miss the match and create two leads.
 */
async function lockContactKeys(tx: Tx, input: LeadInput) {
  const keys = [input.email && `email:${input.email}`, input.phone && `phone:${input.phone}`]
    .filter((k): k is string => !!k)
    .sort();
  for (const key of keys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }
}

async function findMatch(tx: Tx, input: LeadInput): Promise<Lead | null> {
  const or: Prisma.LeadWhereInput[] = [];
  if (input.email) or.push({ email: input.email });
  if (input.phone) or.push({ phone: input.phone });
  if (or.length === 0) return null;
  return tx.lead.findFirst({ where: { OR: or }, orderBy: { createdAt: 'asc' } });
}

// Merge policy: keep what we already know and only fill blanks; first-touch UTM wins;
// answers are merged with the newest winning; consent is sticky once given.
function mergeData(lead: Lead, input: LeadInput): Prisma.LeadUpdateInput {
  const existingFields =
    lead.fields && typeof lead.fields === 'object' && !Array.isArray(lead.fields)
      ? lead.fields
      : {};
  return {
    firstName: lead.firstName ?? input.firstName,
    lastName: lead.lastName ?? input.lastName,
    email: lead.email ?? input.email,
    phone: lead.phone ?? input.phone,
    company: lead.company ?? input.company,
    timezone: lead.timezone ?? input.timezone,
    utm: lead.utm === null && input.utm ? asJson(input.utm) : undefined,
    fields: asJson({ ...existingFields, ...input.fields }),
    consentEmail: lead.consentEmail || input.consentEmail,
    consentMessaging: lead.consentMessaging || input.consentMessaging,
  };
}

export function createCaptureLead(db: Db, queue: JobQueue): CaptureLead {
  async function findCaptured(dedupeKey: string) {
    return db.leadEvent.findUnique({ where: { dedupeKey }, select: { id: true, leadId: true } });
  }

  async function duplicateOf(event: { id: string; leadId: string }): Promise<CaptureResult> {
    // Re-enqueue in case the first attempt failed after the commit; the job id makes it a no-op otherwise.
    await queue.enqueueLeadCaptured({ leadId: event.leadId, eventId: event.id });
    return { leadId: event.leadId, eventId: event.id, duplicate: true };
  }

  return async function captureLead({ source, input, rawPayload }) {
    const dedupeKey = `${source}:${input.externalId}`;

    const existing = await findCaptured(dedupeKey);
    if (existing) return duplicateOf(existing);

    let result: CaptureResult;
    try {
      result = await db.$transaction(async (tx) => {
        await lockContactKeys(tx, input);
        const match = await findMatch(tx, input);

        const lead = match
          ? await tx.lead.update({ where: { id: match.id }, data: mergeData(match, input) })
          : await tx.lead.create({
              data: {
                source,
                firstName: input.firstName,
                lastName: input.lastName,
                email: input.email,
                phone: input.phone,
                company: input.company,
                timezone: input.timezone,
                utm: input.utm ? asJson(input.utm) : undefined,
                fields: asJson(input.fields),
                rawPayload: asJson(rawPayload),
                consentEmail: input.consentEmail,
                consentMessaging: input.consentMessaging,
              },
            });

        const event = await tx.leadEvent.create({
          data: {
            leadId: lead.id,
            type: 'captured',
            dedupeKey,
            payload: asJson({
              source,
              externalId: input.externalId,
              merged: match !== null,
              utm: input.utm,
              rawPayload,
            }),
          },
        });

        return { leadId: lead.id, eventId: event.id, duplicate: false };
      });
    } catch (err) {
      // A concurrent delivery of the same submission committed first.
      if (isUniqueViolation(err)) {
        const winner = await findCaptured(dedupeKey);
        if (winner) return duplicateOf(winner);
      }
      throw err;
    }

    await queue.enqueueLeadCaptured({ leadId: result.leadId, eventId: result.eventId });
    return result;
  };
}
