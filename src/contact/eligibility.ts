import type { Channel, Lead, LeadStatus } from '../generated/prisma/client.js';

/** First contact only goes to leads in these statuses (not engaged, opted out, disqualified…). */
export const CONTACTABLE_STATUSES: readonly LeadStatus[] = ['qualified', 'contacted'];

type EligibilityLead = Pick<
  Lead,
  'status' | 'email' | 'phone' | 'consentEmail' | 'consentMessaging'
>;

export function channelAddress(lead: EligibilityLead, channel: Channel): string | null {
  return channel === 'email' ? lead.email : lead.phone;
}

/** Why the lead can't get a message on `channel` right now, or null when it can. */
export function ineligibleReason(lead: EligibilityLead, channel: Channel): string | null {
  if (!CONTACTABLE_STATUSES.includes(lead.status)) return `status is ${lead.status}`;
  if (!channelAddress(lead, channel)) return `no ${channel === 'email' ? 'email' : 'phone'}`;
  const consent = channel === 'email' ? lead.consentEmail : lead.consentMessaging;
  if (!consent) return `no ${channel === 'email' ? 'email' : 'messaging'} consent`;
  return null;
}
