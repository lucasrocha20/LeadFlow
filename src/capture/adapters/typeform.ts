import { createHmac } from 'node:crypto';
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
} from '../normalize.js';
import type { FormAdapter } from '../types.js';

export const TYPEFORM_SIGNATURE_HEADER = 'typeform-signature';

/** `sha256=<base64 HMAC-SHA256 of the raw body>`, as Typeform sends it. */
export function typeformSignature(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('base64')}`;
}

const answerSchema = z.looseObject({
  type: z.string(),
  field: z.looseObject({ id: z.string(), ref: z.string().optional() }),
});

const typeformPayloadSchema = z.looseObject({
  event_type: z.literal('form_response'),
  form_response: z.looseObject({
    form_id: z.string(),
    /** Unique per response, and stable across webhook retries. */
    token: z.string().min(1),
    submitted_at: z.string().optional(),
    hidden: z.record(z.string(), z.unknown()).optional(),
    definition: z
      .looseObject({
        fields: z
          .array(z.looseObject({ id: z.string(), ref: z.string().optional(), title: z.string() }))
          .optional(),
      })
      .optional(),
    answers: z.array(answerSchema).default([]),
  }),
});

type Answer = z.infer<typeof answerSchema>;

// The answer's value lives under a key named after its type, e.g. { type: 'email', email: '...' }.
function answerValue(answer: Answer): unknown {
  const value = answer[answer.type];
  if (answer.type === 'choice' && value && typeof value === 'object') {
    const choice = value as { label?: string; other?: string };
    return choice.label ?? choice.other ?? null;
  }
  if (answer.type === 'choices' && value && typeof value === 'object') {
    const choices = value as { labels?: string[]; other?: string };
    return [...(choices.labels ?? []), ...(choices.other ? [choices.other] : [])];
  }
  return value ?? null;
}

const CONSENT_REFS = ['consent', 'consent_email', 'consent_messaging'];

const asText = (value: unknown) => (typeof value === 'string' ? value : null);

/**
 * Contact fields are recognised by answer type (email, phone_number) or by the question's
 * `ref`: first_name, last_name, name, company, timezone, consent_email, consent_messaging,
 * consent (both). Every other answer and hidden field is kept in `fields` under its ref;
 * hidden `utm_*` fields become the UTM.
 */
export function typeformAdapter(opts: {
  secret: string;
  defaultCountry: CountryCode;
}): FormAdapter {
  return {
    source: 'typeform',

    verify({ headers, rawBody }) {
      const provided = headers[TYPEFORM_SIGNATURE_HEADER];
      return (
        typeof provided === 'string' && safeEqual(provided, typeformSignature(opts.secret, rawBody))
      );
    },

    normalize(payload) {
      const { form_response: response } = typeformPayloadSchema.parse(payload);

      const byRef: Record<string, unknown> = {};
      let email: string | null = null;
      let phone: string | null = null;
      for (const answer of response.answers) {
        const value = answerValue(answer);
        if (answer.type === 'email' && !email) email = asText(value);
        else if (answer.type === 'phone_number' && !phone) phone = asText(value);
        else byRef[answer.field.ref ?? answer.field.id] = value;
      }

      const { first_name, last_name, name, company, timezone, consent, ...rest } = byRef;
      const { consent_email, consent_messaging, ...fields } = rest;

      const hidden = response.hidden ?? {};
      for (const [key, value] of Object.entries(hidden)) {
        if (!key.startsWith('utm_')) fields[key] = value;
      }

      return {
        externalId: response.token,
        ...resolveName({
          firstName: asText(first_name),
          lastName: asText(last_name),
          fullName: asText(name),
        }),
        email: normalizeEmail(email),
        phone: normalizePhone(phone, opts.defaultCountry),
        company: cleanText(asText(company)),
        timezone: normalizeTimezone(asText(timezone) ?? asText(hidden['timezone'])),
        utm: pickUtm(
          Object.fromEntries(Object.entries(hidden).filter(([k]) => k.startsWith('utm_'))),
        ),
        fields,
        consentEmail: consent_email === true || consent === true,
        consentMessaging: consent_messaging === true || consent === true,
        consentEvidence: {
          formId: response.form_id,
          responseToken: response.token,
          submittedAt: response.submitted_at,
          // The consent questions exactly as the person saw them.
          questions: (response.definition?.fields ?? [])
            .filter((f) => f.ref && CONSENT_REFS.includes(f.ref))
            .map((f) => ({ ref: f.ref, title: f.title })),
        },
      };
    },
  };
}
