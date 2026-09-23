import type { Channel } from '../generated/prisma/client.js';
import type { WebhookRequest } from '../capture/types.js';

/** A message a lead sent us, normalized from any provider. */
export interface InboundMessage {
  channel: Channel;
  /** Provider message id; with the channel, the dedupe key. */
  externalId: string;
  /** E.164 phone number or lowercased email address. */
  from: string;
  text: string;
  /** Email only. */
  subject?: string;
  receivedAt: Date;
}

export interface ReplyAdapter {
  channel: Channel;
  /** Checks the request's signature or shared secret. */
  verify(req: WebhookRequest): boolean;
  /** Messages in the payload (possibly none, e.g. delivery receipts). Throws a ZodError when malformed. */
  parse(payload: unknown): InboundMessage[];
}
