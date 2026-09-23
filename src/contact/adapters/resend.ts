import { renderTemplate } from '../templates.js';
import { PermanentSendError, throwForResponse, type EmailAdapter } from './types.js';

const RESEND_URL = 'https://api.resend.com/emails';

/** Email through Resend (https://resend.com/docs/api-reference/emails/send-email). */
export function resendAdapter(opts: {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
}): EmailAdapter {
  const doFetch = opts.fetch ?? fetch;
  return {
    provider: 'resend',
    async send({ to, template, vars, idempotencyKey }) {
      if (!template.subject) {
        throw new PermanentSendError(`Email template "${template.name}" has no subject`);
      }
      const res = await doFetch(RESEND_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
          // Resend drops a repeated send with the same key (for 24h), e.g. after a crash.
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          from: opts.from,
          to: [to],
          subject: renderTemplate(template.subject, vars),
          text: renderTemplate(template.body, vars),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) await throwForResponse('resend', res);
      const { id } = (await res.json()) as { id: string };
      return { externalId: id };
    },
  };
}
