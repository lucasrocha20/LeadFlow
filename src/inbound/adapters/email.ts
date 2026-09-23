import { z } from 'zod';
import { normalizeEmail, safeEqual, sha256Hex } from '../../capture/normalize.js';
import type { ReplyAdapter } from '../types.js';

export const REPLY_SECRET_HEADER = 'x-webhook-secret';

// Generic JSON for inbound email, relayed by whichever inbound-mail service is used.
const emailReplySchema = z.object({
  /** "Ana Souza <ana@acme.com>" or a bare address. */
  from: z.string().min(1),
  subject: z.string().optional(),
  text: z.string().optional(),
  /** The Message-ID header; dedupes retries. Falls back to a hash of the payload. */
  messageId: z.string().min(1).optional(),
});

function addressOf(from: string): string | null {
  const bracketed = /<([^>]+)>/.exec(from)?.[1];
  return normalizeEmail(bracketed ?? from);
}

export function emailReplyAdapter(opts: { secret: string }): ReplyAdapter {
  return {
    channel: 'email',

    verify({ headers }) {
      const provided = headers[REPLY_SECRET_HEADER];
      return typeof provided === 'string' && safeEqual(provided, opts.secret);
    },

    parse(payload) {
      const data = emailReplySchema.parse(payload);
      const from = addressOf(data.from);
      if (!from) return [];
      return [
        {
          channel: 'email',
          externalId: data.messageId ?? sha256Hex(JSON.stringify(payload)),
          from,
          text: data.text ?? '',
          subject: data.subject,
          receivedAt: new Date(),
        },
      ];
    },
  };
}
