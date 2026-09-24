import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import type { CaptureLead } from './capture/captureLead.js';
import type { FormAdapter } from './capture/types.js';
import type { CrmWebhook } from './crm/webhook.js';
import type { HandleInbound } from './inbound/handleInbound.js';
import type { ReplyAdapter } from './inbound/types.js';
import { loggerOptions, type LoggerConfig } from './logger.js';
import { adminRoutes, type AdminDeps } from './routes/admin.js';
import { healthRoutes, type ReadinessCheck } from './routes/health.js';
import { crmRoutes } from './routes/crm.js';
import { replyRoutes } from './routes/replies.js';
import { unsubscribeRoutes, type UnsubscribeDeps } from './routes/unsubscribe.js';
import { webhookRoutes } from './routes/webhooks.js';

export interface AppDeps {
  config: LoggerConfig & { TRUST_PROXY?: boolean | number | string };
  /** Per-IP request limit; counters live in Redis when given (shared by all API instances). */
  rateLimit?: { perMinute: number; redis?: Redis };
  readinessChecks: Record<string, ReadinessCheck>;
  formAdapters: Record<string, FormAdapter>;
  captureLead: CaptureLead;
  replyAdapters: Record<string, ReplyAdapter>;
  handleInbound: HandleInbound;
  whatsappVerifyToken?: string;
  /** Unsubscribe pages are only served when configured. */
  unsubscribe?: UnsubscribeDeps;
  /** CRM → LeadFlow webhook; only served when configured. */
  crmWebhook?: { webhook: CrmWebhook; publicBaseUrl: string };
  /** Admin API and queue UI under /admin; only served when configured (ADMIN_TOKEN). */
  admin?: AdminDeps;
}

// A hop count trusts that many proxies; Fastify accepts numbers but its types don't.
function trustProxy(value: boolean | number | string | undefined) {
  return typeof value === 'number'
    ? (_address: string, hop: number) => hop < value
    : (value ?? false);
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: loggerOptions(deps.config),
    trustProxy: trustProxy(deps.config.TRUST_PROXY),
  });

  if (deps.rateLimit && deps.rateLimit.perMinute > 0) {
    await app.register(rateLimit, {
      max: deps.rateLimit.perMinute,
      timeWindow: 60_000,
      redis: deps.rateLimit.redis,
      nameSpace: 'leadflow:ratelimit:',
      // If Redis is down, let requests through rather than rejecting webhooks.
      skipOnError: true,
      // Load balancer health checks.
      allowList: (request) => request.url === '/health' || request.url.startsWith('/health/'),
    });
  }

  await app.register(healthRoutes, { checks: deps.readinessChecks });
  await app.register(webhookRoutes, {
    formAdapters: deps.formAdapters,
    captureLead: deps.captureLead,
  });
  await app.register(replyRoutes, {
    replyAdapters: deps.replyAdapters,
    handleInbound: deps.handleInbound,
    whatsappVerifyToken: deps.whatsappVerifyToken,
  });
  if (deps.unsubscribe) {
    await app.register(unsubscribeRoutes, { unsubscribe: deps.unsubscribe });
  }
  if (deps.crmWebhook) {
    await app.register(crmRoutes, deps.crmWebhook);
  }
  if (deps.admin) {
    await app.register(adminRoutes, { ...deps.admin, prefix: '/admin' });
  }

  return app;
}
