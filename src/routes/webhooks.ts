import type { FastifyPluginAsync } from 'fastify';
import { ZodError, z } from 'zod';
import type { CaptureLead } from '../capture/captureLead.js';
import type { FormAdapter } from '../capture/types.js';
import { keepRawJsonBody } from './rawJson.js';

interface WebhookRoutesOptions {
  formAdapters: Record<string, FormAdapter>;
  captureLead: CaptureLead;
}

export const webhookRoutes: FastifyPluginAsync<WebhookRoutesOptions> = async (
  app,
  { formAdapters, captureLead },
) => {
  keepRawJsonBody(app);

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
