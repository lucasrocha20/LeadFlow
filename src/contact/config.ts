import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { normalizeTimezone } from '../capture/normalize.js';
import type { Channel } from '../generated/prisma/client.js';

const channel = z.enum(['email', 'whatsapp', 'sms']);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24h)');

const tierPlan = z.strictObject({
  /** One message per listed channel, sent as soon as allowed. */
  messages: z
    .array(z.strictObject({ channel, template: z.string().min(1) }))
    .refine((m) => new Set(m.map((x) => x.channel)).size === m.length, {
      message: 'At most one message per channel',
    }),
  /** Email template sent to SALES_ALERT_EMAIL. */
  repAlertTemplate: z.string().min(1).optional(),
});

const contactConfigSchema = z.strictObject({
  /**
   * No messages on these channels between `start` and `end` in the lead's time zone (or
   * `defaultTimezone`); they are delayed until `end`. The window may cross midnight.
   */
  quietHours: z
    .strictObject({
      start: time,
      end: time,
      channels: z.array(channel),
      defaultTimezone: z.string().refine((tz) => normalizeTimezone(tz) === tz, {
        message: 'Unknown IANA time zone',
      }),
    })
    .refine((q) => q.start !== q.end, { message: 'start and end must differ' }),
  /** First contact per tier. */
  tiers: z.strictObject({ hot: tierPlan, warm: tierPlan, cold: tierPlan }),
});

export type ContactConfig = z.infer<typeof contactConfigSchema>;

export function parseContactConfig(data: unknown): ContactConfig {
  const result = contactConfigSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid contact config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadContactConfig(path: string): ContactConfig {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read contact config from ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return parseContactConfig(data);
}

/** Every template the config refers to, with the channel it must be for. */
export function referencedTemplates(config: ContactConfig): Map<string, Channel> {
  const templates = new Map<string, Channel>();
  for (const tier of Object.values(config.tiers)) {
    for (const { channel, template } of tier.messages) templates.set(template, channel);
    if (tier.repAlertTemplate) templates.set(tier.repAlertTemplate, 'email');
  }
  return templates;
}
