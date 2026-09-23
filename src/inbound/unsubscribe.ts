import { createHmac } from 'node:crypto';
import { safeEqual } from '../capture/normalize.js';

/** Unforgeable per-lead token, so an unsubscribe link can't be used for someone else. */
export function unsubscribeToken(secret: string, leadId: string): string {
  return createHmac('sha256', secret).update(`unsubscribe:${leadId}`).digest('base64url');
}

export function verifyUnsubscribeToken(secret: string, leadId: string, token: string): boolean {
  return safeEqual(token, unsubscribeToken(secret, leadId));
}

export function unsubscribeUrl(baseUrl: string, secret: string, leadId: string): string {
  const url = new URL('/unsubscribe', baseUrl);
  url.searchParams.set('lead', leadId);
  url.searchParams.set('token', unsubscribeToken(secret, leadId));
  return url.toString();
}
