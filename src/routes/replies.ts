import type { FastifyPluginAsync } from 'fastify';
import { ZodError, z } from 'zod';
import { safeEqual } from '../capture/normalize.js';
import type { HandleInbound } from '../inbound/handleInbound.js';
import type { ReplyAdapter } from '../inbound/types.js';
import { keepRawJsonBody } from './rawJson.js';

interface ReplyRoutesOptions {
  replyAdapters: Record<string, ReplyAdapter>;
  handleInbound: HandleInbound;
  /** Answers Meta's webhook subscription check. */
  whatsappVerifyToken?: string;
}

export const replyRoutes: FastifyPluginAsync<ReplyRoutesOptions> = async (
  app,
  { replyAdapters, handleInbound, whatsappVerifyToken },
) => {
  keepRawJsonBody(app);

  // Meta calls this once when the webhook URL is configured.
  app.get('/webhooks/replies/whatsapp', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const token = query['hub.verify_token'];
    if (
      query['hub.mode'] === 'subscribe' &&
      whatsappVerifyToken &&
      token &&
      safeEqual(token, whatsappVerifyToken)
    ) {
      return reply.type('text/plain').send(query['hub.challenge'] ?? '');
    }
    return reply.code(403).send({ error: 'verification_failed' });
  });

  app.post('/webhooks/replies/:provider', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const adapter = Object.hasOwn(replyAdapters, provider) ? replyAdapters[provider] : undefined;
    if (!adapter) return reply.code(404).send({ error: 'unknown_provider' });

    if (
      !adapter.verify({ headers: request.headers, rawBody: request.rawBody ?? Buffer.alloc(0) })
    ) {
      request.log.warn({ provider }, 'reply webhook rejected: bad signature');
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    let messages;
    try {
      messages = adapter.parse(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ error: 'invalid_payload', details: z.treeifyError(err) });
      }
      throw err;
    }

    const results = [];
    for (const message of messages) {
      const outcome = await handleInbound(message);
      request.log.info({ provider, externalId: message.externalId, ...outcome }, 'reply handled');
      results.push(outcome);
    }
    return reply.code(200).send({ status: 'ok', results });
  });
};
