// Default message templates. Creates missing ones only, so edits made in the database are kept.
// Run with `npm run db:seed` (also runs after `prisma migrate reset`).
import 'dotenv/config';
import { createDb } from '../src/db.js';
import type { Prisma } from '../src/generated/prisma/client.js';

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
];

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is not set');
const db = createDb(url);
try {
  const { count } = await db.template.createMany({ data: templates, skipDuplicates: true });
  console.log(`Templates: ${count} created, ${templates.length - count} already present`);
} finally {
  await db.$disconnect();
}
