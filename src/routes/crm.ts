import type { FastifyPluginAsync } from 'fastify';
import { ZodError, z } from 'zod';
import type { CrmWebhook } from '../crm/webhook.js';
import { keepRawJsonBody } from './rawJson.js';

interface CrmRoutesOptions {
  webhook: CrmWebhook;
  /** Public origin HubSpot calls; the signature covers the full URL. */
  publicBaseUrl: string;
}

export const crmRoutes: FastifyPluginAsync<CrmRoutesOptions> = async (
  app,
  { webhook, publicBaseUrl },
) => {
  keepRawJsonBody(app);

  app.post('/webhooks/crm/hubspot', async (request, reply) => {
    const valid = webhook.verify({
      method: request.method,
      url: new URL(request.url, publicBaseUrl).toString(),
      headers: request.headers,
      rawBody: request.rawBody ?? Buffer.alloc(0),
    });
    if (!valid) {
      request.log.warn('crm webhook rejected: bad signature or stale timestamp');
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    let changes;
    try {
      changes = webhook.parse(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ error: 'invalid_payload', details: z.treeifyError(err) });
      }
      throw err;
    }

    const results = [];
    for (const change of changes) {
      const outcome = await webhook.handle(change);
      if (outcome.status !== 'ignored') {
        request.log.info({ ...change, ...outcome }, 'crm change handled');
      }
      results.push(outcome);
    }
    return reply.code(200).send({ status: 'ok', results });
  });
};
