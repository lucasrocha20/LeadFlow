import type { FastifyPluginAsync } from 'fastify';
import { ZodError, z } from 'zod';
import type { CaptureLead } from '../capture/captureLead.js';
import type { FormAdapter } from '../capture/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

interface WebhookRoutesOptions {
  formAdapters: Record<string, FormAdapter>;
  captureLead: CaptureLead;
}

export const webhookRoutes: FastifyPluginAsync<WebhookRoutesOptions> = async (
  app,
  { formAdapters, captureLead },
) => {
  // Signatures are computed over the exact bytes received, so keep the raw body around.
  // Scoped to this plugin: other routes keep Fastify's default JSON parser.
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

  app.post('/webhooks/forms/:provider', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const adapter = Object.hasOwn(formAdapters, provider) ? formAdapters[provider] : undefined;
    if (!adapter) {
      return reply.code(404).send({ error: 'unknown_provider' });
    }

    if (
      !adapter.verify({ headers: request.headers, rawBody: request.rawBody ?? Buffer.alloc(0) })
    ) {
      request.log.warn({ provider }, 'form webhook rejected: bad signature');
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    let input;
    try {
      input = adapter.normalize(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ error: 'invalid_payload', details: z.treeifyError(err) });
      }
      throw err;
    }

    const result = await captureLead({ source: adapter.source, input, rawPayload: request.body });
    request.log.info({ provider, ...result }, 'lead captured');
    return reply.code(200).send({ status: 'ok', ...result });
  });
};
