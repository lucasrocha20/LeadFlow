import type { CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import {
  cleanText,
  normalizeEmail,
  normalizePhone,
  normalizeTimezone,
  pickUtm,
  resolveName,
  safeEqual,
  sha256Hex,
} from '../normalize.js';
import type { FormAdapter } from '../types.js';

export const WEBSITE_SECRET_HEADER = 'x-webhook-secret';

const text = z.string().nullish();

// Generic JSON posted by our own website backend (or any integration we control).
const websitePayloadSchema = z.object({
  /** Unique per submission; enables dedupe of retries. Falls back to a hash of the payload. */
  submissionId: z.string().min(1).optional(),
  name: text,
  firstName: text,
  lastName: text,
  email: text,
  phone: text,
  company: text,
  timezone: text,
  consentEmail: z.boolean().optional(),
  consentMessaging: z.boolean().optional(),
  /** Proof of consent for the ledger: what the person saw and agreed to, and from where. */
  consent: z
    .object({
      text: z.string().max(2000).optional(),
      version: z.string().max(100).optional(),
      /** When the person submitted (ISO 8601); defaults to when we received it. */
      at: z.iso.datetime({ offset: true }).optional(),
      ip: z.string().max(100).optional(),
      userAgent: z.string().max(500).optional(),
      pageUrl: z.string().max(2000).optional(),
    })
    .optional(),
  utm: z.record(z.string(), z.unknown()).optional(),
  /** Any other answers (budget, company size, message, ...). */
  fields: z.record(z.string(), z.unknown()).optional(),
});

export function websiteFormAdapter(opts: {
  secret: string;
  defaultCountry: CountryCode;
}): FormAdapter {
  return {
    source: 'website',

    verify({ headers }) {
      const provided = headers[WEBSITE_SECRET_HEADER];
      return typeof provided === 'string' && safeEqual(provided, opts.secret);
    },

    normalize(payload) {
      const data = websitePayloadSchema.parse(payload);
      return {
        externalId: data.submissionId ?? sha256Hex(JSON.stringify(payload)),
        ...resolveName({ firstName: data.firstName, lastName: data.lastName, fullName: data.name }),
        email: normalizeEmail(data.email),
        phone: normalizePhone(data.phone, opts.defaultCountry),
        company: cleanText(data.company),
        timezone: normalizeTimezone(data.timezone),
        utm: pickUtm(data.utm),
        fields: data.fields ?? {},
        consentEmail: data.consentEmail ?? false,
        consentMessaging: data.consentMessaging ?? false,
        consentEvidence: {
          submissionId: data.submissionId,
          ...data.consent,
          receivedAt: new Date().toISOString(),
        },
      };
    },
  };
}
