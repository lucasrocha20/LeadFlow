import type { Logger } from 'pino';
import type { Config } from '../../config.js';
import type { Channel } from '../../generated/prisma/client.js';
import { dryRunAdapter } from './dryRun.js';
import { resendAdapter } from './resend.js';
import type { MessageAdapter } from './types.js';
import { whatsappAdapter } from './whatsapp.js';

type AdapterConfig = Pick<
  Config,
  | 'MESSAGING_PROVIDER'
  | 'WHATSAPP_ACCESS_TOKEN'
  | 'WHATSAPP_PHONE_NUMBER_ID'
  | 'EMAIL_PROVIDER'
  | 'EMAIL_FROM'
  | 'RESEND_API_KEY'
>;

export type MessageAdapters = Partial<Record<Channel, MessageAdapter>>;

/** Adapters per channel, per the configured providers. SMS has no provider yet. */
export function createMessageAdapters(config: AdapterConfig, log: Logger): MessageAdapters {
  const dryRun = dryRunAdapter(log);
  return {
    email:
      config.EMAIL_PROVIDER === 'resend'
        ? resendAdapter({ apiKey: config.RESEND_API_KEY!, from: config.EMAIL_FROM! })
        : dryRun,
    whatsapp:
      config.MESSAGING_PROVIDER === 'whatsapp'
        ? whatsappAdapter({
            accessToken: config.WHATSAPP_ACCESS_TOKEN!,
            phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID!,
          })
        : dryRun,
  };
}
