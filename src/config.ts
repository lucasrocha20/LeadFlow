import { isSupportedCountry, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';

// Empty values in .env (e.g. `TYPEFORM_WEBHOOK_SECRET=`) mean "not set".
const optionalSecret = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const configSchema = z.object({
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
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
