// Default message templates and follow-up sequences. Creates missing ones only, so edits made
// in the database are kept.
// Run with `npm run db:seed` (also runs after `prisma migrate reset`).
import 'dotenv/config';
import { createDb } from '../src/db.js';
import type { Prisma } from '../src/generated/prisma/client.js';

const UNSUBSCRIBE_FOOTER =
  "Don't want to hear from us? {{unsubscribeUrl|Reply STOP to unsubscribe.}}";

const templates: Prisma.TemplateCreateManyInput[] = [
  {
    // Must match a template approved in Meta (same name, language and body parameters).
    name: 'first_contact_whatsapp',
    channel: 'whatsapp',
    locale: 'en_US',
    body:
      'Hi {{firstName|there}}! Thanks for your interest. I would love to learn more about what ' +
      'you need. When is a good time for a quick chat?',
  },
  {
    name: 'first_contact_email',
    channel: 'email',
    subject: 'Thanks for reaching out, {{firstName|there}}',
    body: [
      'Hi {{firstName|there}},',
      '',
      'Thanks for getting in touch! I would love to learn more about what you need and show you how we can help.',
      '',
      'Just reply to this email with a good time for a quick call.',
      '',
      'Best regards,',
      'The Sales Team',
      '',
      UNSUBSCRIBE_FOOTER,
    ].join('\n'),
  },
  {
    name: 'rep_alert_hot_lead',
    channel: 'email',
    subject: 'Hot lead: {{fullName|Unknown name}} ({{company|no company}})',
    body: [
      'A hot lead just came in. Reach out now.',
      '',
      'Name: {{fullName|-}}',
      'Company: {{company|-}}',
      'Email: {{email|-}}',
      'Phone: {{phone|-}}',
      'Source: {{source}}',
      'Score: {{score|-}}',
    ].join('\n'),
  },
  {
    // Must also be approved in Meta; sent outside the 24h window, so it has to be a template.
    name: 'follow_up_whatsapp',
    channel: 'whatsapp',
    locale: 'en_US',
    body:
      'Hi {{firstName|there}}, just following up on your request. Is this a good time for a ' +
      'quick chat? Reply STOP to opt out.',
  },
  {
    name: 'follow_up_email',
    channel: 'email',
    subject: 'Following up, {{firstName|there}}',
    body: [
      'Hi {{firstName|there}},',
      '',
      'I wanted to follow up on your request. Do you have 15 minutes this week for a quick call?',
      '',
      'Best regards,',
      'The Sales Team',
      '',
      UNSUBSCRIBE_FOOTER,
    ].join('\n'),
  },
  {
    name: 'check_in_email',
    channel: 'email',
    subject: 'Any questions, {{firstName|there}}?',
    body: [
      'Hi {{firstName|there}},',
      '',
      'Checking in: is there anything I can answer to help you decide? Just reply to this email.',
      '',
      'Best regards,',
      'The Sales Team',
      '',
      UNSUBSCRIBE_FOOTER,
    ].join('\n'),
  },
  {
    name: 'last_try_email',
    channel: 'email',
    subject: 'Should I close your request?',
    body: [
      'Hi {{firstName|there}},',
      '',
      "I haven't heard back, so I'll assume now isn't the right time and close your request.",
      'If I got that wrong, just reply and I will get back to you right away.',
      '',
      'Best regards,',
      'The Sales Team',
      '',
      UNSUBSCRIBE_FOOTER,
    ].join('\n'),
  },
  {
    name: 'rep_alert_reply',
    channel: 'email',
    subject: '{{fullName|A lead}} replied on {{replyChannel}}',
    body: [
      '{{fullName|A lead}} ({{company|no company}}) replied. Their follow-up sequence has stopped.',
      '',
      '"{{replyText}}"',
      '',
      'Email: {{email|-}}',
      'Phone: {{phone|-}}',
      'Tier: {{tier|-}}',
    ].join('\n'),
  },
];

const HOUR = 60;
const DAY = 24 * HOUR;

// Offsets count from enrollment (the first contact). `config/contact.json` picks one per tier.
const sequences: {
  name: string;
  tier: 'hot' | 'warm' | 'cold';
  finalWaitMinutes: number;
  steps: { offsetMinutes: number; channel: 'email' | 'whatsapp'; template: string }[];
}[] = [
  {
    name: 'hot_follow_up',
    tier: 'hot',
    finalWaitMinutes: 3 * DAY,
    steps: [
      { offsetMinutes: 1 * HOUR, channel: 'whatsapp', template: 'follow_up_whatsapp' },
      { offsetMinutes: 1 * DAY, channel: 'email', template: 'follow_up_email' },
      { offsetMinutes: 3 * DAY, channel: 'email', template: 'last_try_email' },
    ],
  },
  {
    name: 'warm_follow_up',
    tier: 'warm',
    finalWaitMinutes: 3 * DAY,
    steps: [
      { offsetMinutes: 1 * DAY, channel: 'email', template: 'follow_up_email' },
      { offsetMinutes: 3 * DAY, channel: 'whatsapp', template: 'follow_up_whatsapp' },
      { offsetMinutes: 7 * DAY, channel: 'email', template: 'last_try_email' },
    ],
  },
  {
    name: 'cold_follow_up',
    tier: 'cold',
    finalWaitMinutes: 7 * DAY,
    steps: [
      { offsetMinutes: 3 * DAY, channel: 'email', template: 'follow_up_email' },
      { offsetMinutes: 7 * DAY, channel: 'email', template: 'check_in_email' },
      { offsetMinutes: 14 * DAY, channel: 'email', template: 'last_try_email' },
    ],
  },
];

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is not set');
const db = createDb(url);
try {
  const { count } = await db.template.createMany({ data: templates, skipDuplicates: true });
  console.log(`Templates: ${count} created, ${templates.length - count} already present`);

  let created = 0;
  for (const { steps, ...sequence } of sequences) {
    if (await db.sequence.findUnique({ where: { name: sequence.name } })) continue;
    await db.sequence.create({
      data: {
        ...sequence,
        steps: {
          create: steps.map((step, i) => ({
            order: i + 1,
            offsetMinutes: step.offsetMinutes,
            channel: step.channel,
            template: { connect: { name: step.template } },
          })),
        },
      },
    });
    created++;
  }
  console.log(`Sequences: ${created} created, ${sequences.length - created} already present`);
} finally {
  await db.$disconnect();
}
