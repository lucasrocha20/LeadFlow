import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { safeEqual } from '../../capture/normalize.js';
import type { InboundMessage, ReplyAdapter } from '../types.js';

export const WHATSAPP_SIGNATURE_HEADER = 'x-hub-signature-256';

/** `sha256=<hex HMAC-SHA256 of the raw body, keyed with the App Secret>`, as Meta sends it. */
export function whatsappSignature(appSecret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

const messageSchema = z.looseObject({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  button: z.looseObject({ text: z.string() }).optional(),
  interactive: z
    .looseObject({
      button_reply: z.looseObject({ title: z.string() }).optional(),
      list_reply: z.looseObject({ title: z.string() }).optional(),
    })
    .optional(),
});

const payloadSchema = z.looseObject({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.looseObject({
      changes: z.array(
        z.looseObject({
          value: z.looseObject({ messages: z.array(messageSchema).optional() }),
        }),
      ),
    }),
  ),
});

type WhatsAppMessage = z.infer<typeof messageSchema>;

// Text of the message, or of the quick-reply button the lead tapped; empty for media.
function textOf(message: WhatsAppMessage): string {
  return (
    message.text?.body ??
    message.button?.text ??
    message.interactive?.button_reply?.title ??
    message.interactive?.list_reply?.title ??
    ''
  );
}

/** WhatsApp Cloud API webhook (`messages` field). Status updates are ignored. */
export function whatsappReplyAdapter(opts: { appSecret: string }): ReplyAdapter {
  return {
    channel: 'whatsapp',

    verify({ headers, rawBody }) {
      const provided = headers[WHATSAPP_SIGNATURE_HEADER];
      return (
        typeof provided === 'string' &&
        safeEqual(provided, whatsappSignature(opts.appSecret, rawBody))
      );
    },

    parse(payload) {
      const data = payloadSchema.parse(payload);
      return data.entry.flatMap((entry) =>
        entry.changes.flatMap((change) =>
          (change.value.messages ?? []).map((message): InboundMessage => ({
            channel: 'whatsapp',
            externalId: message.id,
            from: `+${message.from.replace(/^\+/, '')}`,
            text: textOf(message),
            receivedAt: new Date(Number(message.timestamp) * 1000),
          })),
        ),
      );
    },
  };
}
