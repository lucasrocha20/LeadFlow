import { isSupportedCountry, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';

// Empty values in .env (e.g. `TYPEFORM_WEBHOOK_SECRET=`) mean "not set".
const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v);
const optionalSecret = z.preprocess(emptyAsUndefined, z.string().optional());

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  // Region used to parse phone numbers submitted without a country code.
  DEFAULT_PHONE_COUNTRY: z
    .custom<CountryCode>((v) => typeof v === 'string' && isSupportedCountry(v), {
      message: 'Expected an ISO 3166-1 alpha-2 country code, e.g. BR or US',
    })
    .default('BR'),

  // A form provider's webhook is only enabled when its secret is set.
  FORM_WEBHOOK_SECRET: optionalSecret,
  TYPEFORM_WEBHOOK_SECRET: optionalSecret,

  // JSON file with the scoring rules, tiers and disqualifiers used by the worker.
  SCORING_RULES_PATH: z.string().min(1).default('config/scoring.json'),

  // First contact: channel strategy per tier, quiet hours (JSON).
  CONTACT_CONFIG_PATH: z.string().min(1).default('config/contact.json'),
  // Where hot-lead alerts go; alerts are skipped when unset.
  SALES_ALERT_EMAIL: z.preprocess(emptyAsUndefined, z.email().optional()),

  // `dry-run` logs messages instead of sending them.
  MESSAGING_PROVIDER: z.enum(['dry-run', 'whatsapp']).default('dry-run'),
  WHATSAPP_ACCESS_TOKEN: optionalSecret,
  WHATSAPP_PHONE_NUMBER_ID: optionalSecret,
  // Inbound WhatsApp webhook: the App Secret verifies X-Hub-Signature-256, the verify token
  // answers Meta's subscription check. Replies are only accepted when the App Secret is set.
  WHATSAPP_APP_SECRET: optionalSecret,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: optionalSecret,

  EMAIL_PROVIDER: z.enum(['dry-run', 'resend']).default('dry-run'),
  // Sender address, e.g. "Acme Sales <sales@acme.com>".
  EMAIL_FROM: optionalSecret,
  RESEND_API_KEY: optionalSecret,

  // Inbound email replies, relayed as JSON with this secret in X-Webhook-Secret.
  REPLY_WEBHOOK_SECRET: optionalSecret,

  // Unsubscribe links (`{{unsubscribeUrl}}` in templates) need both.
  PUBLIC_BASE_URL: z.preprocess(emptyAsUndefined, z.url({ protocol: /^https?$/ }).optional()),
  UNSUBSCRIBE_SECRET: optionalSecret,
});

// Credentials are only required for the provider actually selected.
const requiredFor: [
  keyof z.infer<typeof baseSchema>,
  string,
  (keyof z.infer<typeof baseSchema>)[],
][] = [
  ['MESSAGING_PROVIDER', 'whatsapp', ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']],
  ['EMAIL_PROVIDER', 'resend', ['RESEND_API_KEY', 'EMAIL_FROM']],
];

const configSchema = baseSchema.superRefine((config, ctx) => {
  if (Boolean(config.PUBLIC_BASE_URL) !== Boolean(config.UNSUBSCRIBE_SECRET)) {
    ctx.addIssue({
      code: 'custom',
      path: [config.PUBLIC_BASE_URL ? 'UNSUBSCRIBE_SECRET' : 'PUBLIC_BASE_URL'],
      message: 'PUBLIC_BASE_URL and UNSUBSCRIBE_SECRET must be set together',
    });
  }
  for (const [selector, value, keys] of requiredFor) {
    if (config[selector] !== value) continue;
    for (const key of keys) {
      if (!config[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `Required when ${selector}=${value}`,
        });
      }
    }
  }
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
