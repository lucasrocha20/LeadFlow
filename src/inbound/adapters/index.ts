import type { Config } from '../../config.js';
import type { ReplyAdapter } from '../types.js';
import { emailReplyAdapter } from './email.js';
import { whatsappReplyAdapter } from './whatsapp.js';

type AdapterConfig = Pick<Config, 'WHATSAPP_APP_SECRET' | 'REPLY_WEBHOOK_SECRET'>;

/** Reply adapters keyed by the `:provider` URL segment. Providers without a secret stay disabled. */
export function createReplyAdapters(config: AdapterConfig): Record<string, ReplyAdapter> {
  const adapters: Record<string, ReplyAdapter> = {};
  if (config.WHATSAPP_APP_SECRET) {
    adapters['whatsapp'] = whatsappReplyAdapter({ appSecret: config.WHATSAPP_APP_SECRET });
  }
  if (config.REPLY_WEBHOOK_SECRET) {
    adapters['email'] = emailReplyAdapter({ secret: config.REPLY_WEBHOOK_SECRET });
  }
  return adapters;
}
