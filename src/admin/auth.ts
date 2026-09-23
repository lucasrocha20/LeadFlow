import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Hashing first gives equal-length buffers, so the comparison doesn't leak the token's length.
const digest = (value: string) => createHash('sha256').update(value).digest();

/** The token from `Authorization: Bearer <token>` or Basic auth (any username). */
export function presentedToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, value = ''] = authorization.split(' ', 2);
  switch (scheme?.toLowerCase()) {
    case 'bearer':
      return value || null;
    case 'basic': {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      return colon >= 0 ? decoded.slice(colon + 1) : null;
    }
    default:
      return null;
  }
}

/**
 * An onRequest hook that only lets through requests carrying the admin token. Browsers get a
 * Basic-auth prompt, so the queue UI works without extra tooling.
 */
export function adminAuth(token: string) {
  const expected = digest(token);
  return async function checkAdminToken(request: FastifyRequest, reply: FastifyReply) {
    const presented = presentedToken(request.headers.authorization);
    if (presented && timingSafeEqual(digest(presented), expected)) return;
    request.log.warn({ url: request.url }, 'admin request rejected');
    return reply
      .code(401)
      .header('www-authenticate', 'Basic realm="LeadFlow admin", charset="UTF-8"')
      .send({ error: 'unauthorized' });
  };
}
