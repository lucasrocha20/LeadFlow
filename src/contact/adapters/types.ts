import type { Channel } from '../../generated/prisma/client.js';
import type { TemplateVars } from '../templates.js';

export interface MessageTemplate {
  name: string;
  channel: Channel;
  subject: string | null;
  body: string;
  locale: string | null;
}

export interface SendRequest {
  /** Email address or E.164 phone number. */
  to: string;
  template: MessageTemplate;
  vars: TemplateVars;
  /** Stable per logical message; passed to providers that support idempotent sends. */
  idempotencyKey: string;
}

/**
 * One implementation per provider. The plan's `MessagingAdapter` (WhatsApp/SMS) and
 * `EmailAdapter` share this shape; adapters are registered per channel.
 */
export interface MessageAdapter {
  provider: string;
  /** Returns the provider's message id. */
  send(req: SendRequest): Promise<{ externalId: string }>;
}

export type MessagingAdapter = MessageAdapter;
export type EmailAdapter = MessageAdapter;

/** A failure that retrying won't fix (invalid number, rejected template, bad template data). */
export class PermanentSendError extends Error {
  override name = 'PermanentSendError';
}

/** Throws the right error for a failed provider HTTP response: 429 and 5xx are retryable. */
export async function throwForResponse(provider: string, res: Response): Promise<never> {
  const detail = (await res.text().catch(() => '')).slice(0, 500);
  const message = `${provider} responded ${res.status}: ${detail}`;
  if (res.status === 429 || res.status >= 500) throw new Error(message);
  throw new PermanentSendError(message);
}
