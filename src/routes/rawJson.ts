import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/**
 * Parses JSON bodies but keeps the exact bytes in `request.rawBody`, which signatures are
 * computed over. Call it inside a plugin so other routes keep Fastify's default parser.
 */
export function keepRawJsonBody(app: FastifyInstance) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const raw = body as Buffer;
    request.rawBody = raw;
    try {
      done(null, raw.length > 0 ? JSON.parse(raw.toString('utf8')) : undefined);
    } catch {
      done(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }), undefined);
    }
  });
}
