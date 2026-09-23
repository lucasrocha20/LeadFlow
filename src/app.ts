import Fastify from 'fastify';
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
  config: LoggerConfig;
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

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: loggerOptions(deps.config) });

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
