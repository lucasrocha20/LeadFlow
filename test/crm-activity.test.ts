import { describe, expect, it } from 'vitest';
import { describeEvent } from '../src/crm/activity.js';
import type { LeadEventType } from '../src/generated/prisma/client.js';

const at = new Date('2026-09-23T15:00:00Z');
const describe_ = (
  type: LeadEventType,
  payload: unknown,
  channel: 'email' | 'whatsapp' | null = null,
) => describeEvent({ type, channel, payload: payload as never, createdAt: at });

describe('describeEvent', () => {
  it.each([
    [
      'captured',
      { source: 'typeform', merged: true, utm: { source: 'google', medium: 'cpc' } },
      null,
      'LeadFlow: Lead captured from typeform',
      'Merged into the existing lead (same email or phone).\nUTM: source=google, medium=cpc',
    ],
    [
      'scored',
      {
        score: 95,
        tier: 'hot',
        matchedRules: [{ id: 'budget-high', points: 30 }],
        disqualifiedBy: [],
      },
      null,
      'LeadFlow: Scored 95 → hot',
      'Rules: budget-high (30)',
    ],
    [
      'message_sent',
      { kind: 'first_contact', template: 'first_contact_whatsapp', to: '+5511987654321' },
      'whatsapp',
      'LeadFlow: WhatsApp first contact sent',
      'Template: first_contact_whatsapp\nTo: +5511987654321',
    ],
    [
      'message_failed',
      { kind: 'follow_up', template: 'follow_up_email', error: 'resend responded 422' },
      'email',
      'LeadFlow: Email follow-up failed',
      'Template: follow_up_email\nError: resend responded 422',
    ],
    [
      'reply_received',
      { text: 'Call me tomorrow', subject: 'Re: Hi' },
      'email',
      'LeadFlow: Reply received on Email',
      'Subject: Re: Hi\nCall me tomorrow',
    ],
    [
      'opted_out',
      { source: 'unsubscribe_link' },
      null,
      'LeadFlow: Opted out of all messages',
      'Via unsubscribe link',
    ],
    [
      'opted_out',
      { source: 'suppression_list' },
      null,
      'LeadFlow: Opted out of all messages',
      'Via suppression list (this address was erased or opted out before)',
    ],
    [
      'enrolled',
      { sequence: 'hot_follow_up' },
      null,
      'LeadFlow: Enrolled in follow-up sequence hot_follow_up',
      '',
    ],
    [
      'sequence_stopped',
      { sequence: 'hot_follow_up', reason: 'replied' },
      null,
      'LeadFlow: Follow-up hot_follow_up stopped',
      'Reason: replied',
    ],
    [
      'sequence_paused',
      { sequence: 'hot_follow_up', reason: 'talking by phone' },
      null,
      'LeadFlow: Follow-up hot_follow_up paused',
      'Reason: talking by phone',
    ],
    [
      'sequence_resumed',
      { sequence: 'hot_follow_up' },
      null,
      'LeadFlow: Follow-up hot_follow_up resumed',
      '',
    ],
    [
      'sequence_completed',
      { sequence: 'cold_follow_up' },
      null,
      'LeadFlow: Follow-up cold_follow_up finished without a reply',
      '',
    ],
    [
      'status_changed',
      { from: 'engaged', to: 'converted', source: 'crm (lifecyclestage = customer)' },
      null,
      'LeadFlow: Status changed from engaged to converted',
      'Source: crm (lifecyclestage = customer)',
    ],
    [
      'rep_notified',
      { template: 'rep_alert_hot_lead' },
      'email',
      'LeadFlow: Sales rep alerted',
      'Template: rep_alert_hot_lead',
    ],
  ] as const)('%s', (type, payload, channel, title, body) => {
    expect(describe_(type, payload, channel)).toEqual({ title, body, occurredAt: at });
  });
});
