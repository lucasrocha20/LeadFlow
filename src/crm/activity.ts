import type { LeadEvent, LeadEventType } from '../generated/prisma/client.js';
import type { CrmActivity } from './types.js';

/** Events about the CRM sync itself are not pushed to the CRM. */
export const NOT_SYNCED: LeadEventType[] = ['crm_synced', 'crm_sync_failed'];

type Payload = Record<string, unknown>;

const CHANNEL: Record<string, string> = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };
const KIND: Record<string, string> = {
  first_contact: 'first contact',
  follow_up: 'follow-up',
  rep_alert: 'rep alert',
};

const text = (value: unknown) => (value === undefined || value === null ? '' : String(value));
const lines = (...parts: (string | false | null | undefined)[]) =>
  parts.filter((p): p is string => Boolean(p)).join('\n');

/** A human-readable timeline entry for a LeadFlow event. */
export function describeEvent(
  event: Pick<LeadEvent, 'type' | 'channel' | 'payload' | 'createdAt'>,
): CrmActivity {
  const p = (event.payload ?? {}) as Payload;
  const channel = CHANNEL[event.channel ?? ''] ?? text(event.channel);
  const [title, body] = ((): [string, string] => {
    switch (event.type) {
      case 'captured': {
        const utm = p['utm'] as Payload | null | undefined;
        return [
          `Lead captured from ${text(p['source'])}`,
          lines(
            p['merged'] === true && 'Merged into the existing lead (same email or phone).',
            utm &&
              `UTM: ${Object.entries(utm)
                .map(([k, v]) => `${k}=${text(v)}`)
                .join(', ')}`,
          ),
        ];
      }
      case 'scored': {
        const rules = (p['matchedRules'] as { id: string; points: number }[] | undefined) ?? [];
        const disqualifiedBy = (p['disqualifiedBy'] as string[] | undefined) ?? [];
        return [
          `Scored ${text(p['score'])} → ${text(p['tier'])}`,
          lines(
            rules.length > 0 && `Rules: ${rules.map((r) => `${r.id} (${r.points})`).join(', ')}`,
            disqualifiedBy.length > 0 && `Disqualified by: ${disqualifiedBy.join(', ')}`,
          ),
        ];
      }
      case 'message_sent':
        return [
          `${channel} ${KIND[text(p['kind'])] ?? 'message'} sent`,
          lines(
            `Template: ${text(p['template'])}`,
            p['to'] !== undefined && `To: ${text(p['to'])}`,
          ),
        ];
      case 'message_failed':
        return [
          `${channel} ${KIND[text(p['kind'])] ?? 'message'} failed`,
          lines(`Template: ${text(p['template'])}`, `Error: ${text(p['error'])}`),
        ];
      case 'rep_notified':
        return ['Sales rep alerted', `Template: ${text(p['template'])}`];
      case 'reply_received':
        return [
          `Reply received on ${channel}`,
          lines(p['subject'] !== undefined && `Subject: ${text(p['subject'])}`, text(p['text'])),
        ];
      case 'opted_out':
        return [
          'Opted out of all messages',
          `Via ${p['source'] === 'unsubscribe_link' ? 'unsubscribe link' : 'reply'}`,
        ];
      case 'enrolled':
        return [`Enrolled in follow-up sequence ${text(p['sequence'])}`, ''];
      case 'sequence_stopped':
        return [`Follow-up ${text(p['sequence'])} stopped`, `Reason: ${text(p['reason'])}`];
      case 'sequence_completed':
        return [`Follow-up ${text(p['sequence'])} finished without a reply`, ''];
      case 'status_changed':
        return [
          `Status changed from ${text(p['from'])} to ${text(p['to'])}`,
          p['source'] ? `Source: ${text(p['source'])}` : '',
        ];
      default:
        return [event.type.replaceAll('_', ' '), JSON.stringify(p)];
    }
  })();
  return { title: `LeadFlow: ${title}`, body, occurredAt: event.createdAt };
}
