import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { safeEqual } from '../capture/normalize.js';
import { CONTACTABLE_STATUSES } from '../contact/eligibility.js';
import { asJson, isUniqueViolation, type Db } from '../db.js';
import { stopEnrollments } from '../followup/enrollment.js';
import type { CrmConfig } from './config.js';

/** A field a rep changed on a CRM contact. */
export interface CrmChange {
  /** Provider event id; dedupes redeliveries. */
  eventId: string;
  crmId: string;
  property: string;
  value: string;
}

export interface CrmWebhookRequest {
  method: string;
  /** Full URL HubSpot called, e.g. https://leads.example.com/webhooks/crm/hubspot. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

export interface CrmWebhook {
  verify(req: CrmWebhookRequest): boolean;
  parse(payload: unknown): CrmChange[];
  handle(change: CrmChange): Promise<CrmChangeOutcome>;
}

export type CrmChangeOutcome =
  | { status: 'ignored' }
  | { status: 'unmatched' }
  | { status: 'duplicate' }
  | { status: 'unchanged'; leadId: string }
  | { status: 'updated'; leadId: string; from: string; to: string; stoppedSequences: number };

const MAX_AGE_MS = 5 * 60_000;

/** HubSpot v3 signature: base64 HMAC-SHA256 of method + URI + body + timestamp. */
export function hubspotSignature(
  secret: string,
  req: { method: string; url: string; rawBody: Buffer | string },
  timestamp: string,
): string {
  return createHmac('sha256', secret)
    .update(`${req.method}${req.url}${req.rawBody.toString()}${timestamp}`)
    .digest('base64');
}

const eventsSchema = z.array(
  z.looseObject({
    eventId: z.union([z.number(), z.string()]),
    subscriptionType: z.string(),
    objectId: z.union([z.number(), z.string()]),
    propertyName: z.string().optional(),
    propertyValue: z.string().optional(),
  }),
);

/**
 * HubSpot → LeadFlow: `contact.propertyChange` events whose property/value match a rule in
 * `config/crm.json` (`inbound`) set the lead's status, e.g. lifecycle stage "customer" →
 * `converted`, which also stops its follow-up.
 */
export function hubspotWebhook({
  db,
  secret,
  config,
  now = () => Date.now(),
}: {
  db: Db;
  secret: string;
  config: Pick<CrmConfig, 'inbound'>;
  now?: () => number;
}): CrmWebhook {
  return {
    verify(req) {
      const signature = req.headers['x-hubspot-signature-v3'];
      const timestamp = req.headers['x-hubspot-request-timestamp'];
      if (typeof signature !== 'string' || typeof timestamp !== 'string') return false;
      if (!(Math.abs(now() - Number(timestamp)) <= MAX_AGE_MS)) return false;
      return safeEqual(signature, hubspotSignature(secret, req, timestamp));
    },

    parse(payload) {
      return eventsSchema
        .parse(payload)
        .filter((e) => e.subscriptionType === 'contact.propertyChange' && e.propertyName)
        .map((e) => ({
          eventId: String(e.eventId),
          crmId: String(e.objectId),
          property: e.propertyName!,
          value: e.propertyValue ?? '',
        }));
    },

    async handle(change) {
      const rule = config.inbound.find(
        (r) => r.property === change.property && r.value === change.value,
      );
      if (!rule) return { status: 'ignored' };
      const match = await db.lead.findFirst({
        where: { crmId: change.crmId },
        orderBy: { createdAt: 'asc' },
      });
      if (!match) return { status: 'unmatched' };

      try {
        return await db.$transaction(async (tx): Promise<CrmChangeOutcome> => {
          await tx.$executeRaw`SELECT 1 FROM "Lead" WHERE id = ${match.id} FOR UPDATE`;
          const lead = await tx.lead.findUniqueOrThrow({ where: { id: match.id } });
          if (lead.status === rule.status) return { status: 'unchanged', leadId: lead.id };

          await tx.lead.update({ where: { id: lead.id }, data: { status: rule.status } });
          await tx.leadEvent.create({
            data: {
              leadId: lead.id,
              type: 'status_changed',
              dedupeKey: `crm:hubspot:${change.eventId}`,
              payload: asJson({
                from: lead.status,
                to: rule.status,
                source: `crm (${change.property} = ${change.value})`,
              }),
            },
          });
          const stoppedSequences = CONTACTABLE_STATUSES.includes(rule.status)
            ? 0
            : await stopEnrollments(tx, lead.id, `crm: ${change.property} = ${change.value}`);
          return {
            status: 'updated',
            leadId: lead.id,
            from: lead.status,
            to: rule.status,
            stoppedSequences,
          };
        });
      } catch (err) {
        if (isUniqueViolation(err)) return { status: 'duplicate' };
        throw err;
      }
    },
  };
}
