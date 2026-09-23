import type { Db } from '../db.js';
import type { Channel } from '../generated/prisma/client.js';
import type { JobQueue, LeadQualifiedJob, SendMessageJob } from '../queue.js';
import type { MessageAdapters } from './adapters/index.js';
import type { ContactConfig } from './config.js';
import { CONTACTABLE_STATUSES, ineligibleReason } from './eligibility.js';
import { quietHoursDelayMs } from './quietHours.js';

export const firstContactKey = (leadId: string, channel: Channel) =>
  `first-contact:${leadId}:${channel}`;
export const repAlertKey = (leadId: string) => `rep-alert:${leadId}`;

export interface PlanResult {
  leadId: string;
  scheduled: {
    kind: SendMessageJob['kind'];
    channel: Channel;
    template: string;
    delayMs: number;
  }[];
  skipped: { kind: SendMessageJob['kind']; channel?: Channel; reason: string }[];
}

export type PlanFirstContact = (job: LeadQualifiedJob) => Promise<PlanResult | null>;

export interface PlanDeps {
  db: Db;
  queue: JobQueue;
  config: ContactConfig;
  adapters: MessageAdapters;
  salesAlertEmail?: string;
  now?: () => Date;
}

/**
 * Handles `lead.qualified`: decides which first-contact messages the lead gets (per its current
 * tier, consent and address) and enqueues one `message.send` job each, delayed past quiet hours.
 * Each channel is contacted at most once per lead, so re-qualifying only adds channels a
 * higher tier brings (e.g. WhatsApp after cold → hot).
 */
export function createPlanFirstContact({
  db,
  queue,
  config,
  adapters,
  salesAlertEmail,
  now = () => new Date(),
}: PlanDeps): PlanFirstContact {
  return async function planFirstContact({ leadId }) {
    const lead = await db.lead.findUnique({ where: { id: leadId } });
    if (!lead) return null;

    const result: PlanResult = { leadId, scheduled: [], skipped: [] };
    // The tier may have changed since the job was enqueued; use the current one.
    if (!CONTACTABLE_STATUSES.includes(lead.status) || !lead.tier || lead.tier === 'disqualified') {
      result.skipped.push({
        kind: 'first_contact',
        reason: `status is ${lead.status}, tier is ${lead.tier}`,
      });
      return result;
    }
    const plan = config.tiers[lead.tier];

    const keys = [
      ...plan.messages.map((m) => firstContactKey(leadId, m.channel)),
      repAlertKey(leadId),
    ];
    const done = await db.leadEvent.findMany({
      where: { dedupeKey: { in: keys } },
      select: { dedupeKey: true },
    });
    const alreadySent = new Set(done.map((e) => e.dedupeKey));

    for (const { channel, template } of plan.messages) {
      const dedupeKey = firstContactKey(leadId, channel);
      const reason =
        ineligibleReason(lead, channel) ??
        (adapters[channel] ? null : `no provider for ${channel}`) ??
        (alreadySent.has(dedupeKey) ? 'already sent' : null);
      if (reason) {
        result.skipped.push({ kind: 'first_contact', channel, reason });
        continue;
      }

      const { quietHours } = config;
      const delayMs = quietHours.channels.includes(channel)
        ? quietHoursDelayMs(now(), lead.timezone ?? quietHours.defaultTimezone, quietHours)
        : 0;
      await queue.enqueueSendMessage(
        { leadId, kind: 'first_contact', channel, template, dedupeKey },
        { delayMs },
      );
      result.scheduled.push({ kind: 'first_contact', channel, template, delayMs });
    }

    if (plan.repAlertTemplate) {
      const dedupeKey = repAlertKey(leadId);
      const reason = !salesAlertEmail
        ? 'SALES_ALERT_EMAIL not set'
        : alreadySent.has(dedupeKey)
          ? 'already sent'
          : null;
      if (reason) {
        result.skipped.push({ kind: 'rep_alert', channel: 'email', reason });
      } else {
        const template = plan.repAlertTemplate;
        await queue.enqueueSendMessage({
          leadId,
          kind: 'rep_alert',
          channel: 'email',
          template,
          to: salesAlertEmail,
          dedupeKey,
        });
        result.scheduled.push({ kind: 'rep_alert', channel: 'email', template, delayMs: 0 });
      }
    }

    return result;
  };
}
