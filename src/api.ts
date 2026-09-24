import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { createAdminService } from './admin/service.js';
import { buildApp } from './app.js';
import { createFormAdapters } from './capture/adapters/index.js';
import { createCaptureLead } from './capture/captureLead.js';
import { alertThresholds, type Config } from './config.js';
import type { ContactConfig } from './contact/config.js';
import { createCrmAdapter } from './crm/adapters/index.js';
import type { CrmConfig } from './crm/config.js';
import type { CrmAdapter } from './crm/types.js';
import { hubspotWebhook } from './crm/webhook.js';
import type { Db } from './db.js';
import { createReplyAdapters } from './inbound/adapters/index.js';
import { createHandleInbound } from './inbound/handleInbound.js';
import { createOptOut } from './inbound/optOut.js';
import { verifyUnsubscribeToken } from './inbound/unsubscribe.js';
import { loggerOptions } from './logger.js';
import { createJobQueue, createQueueMonitor } from './queue.js';

export interface ApiDeps {
  config: Config;
  db: Db;
  contactConfig: ContactConfig;
  crmConfig: CrmConfig;
  /** Fail-fast connection (`enableOfflineQueue: false`), so a webhook errors (and the
   * provider retries) instead of hanging while Redis is down. */
  redis: Redis;
  /** BullMQ key prefix (tests isolate their queues). */
  prefix?: string;
  /** For erasure requests; defaults to the provider selected in `config`. */
  crm?: CrmAdapter;
}

/** The HTTP API with its real dependencies. `src/server.ts` listens with it. */
export async function createApi({
  config,
  db,
  contactConfig,
  crmConfig,
  redis,
  prefix,
  crm,
}: ApiDeps) {
  const warn = (msg: string) => (err: unknown) => app.log.warn({ err }, msg);
  const queue = createJobQueue(redis, warn('redis connection error'), { prefix });
  const formAdapters = createFormAdapters(config);
  const replyAdapters = createReplyAdapters(config);
  const unsubscribeSecret = config.UNSUBSCRIBE_SECRET;
  const hubspotSecret =
    config.CRM_PROVIDER === 'hubspot' ? config.HUBSPOT_CLIENT_SECRET : undefined;
  const publicBaseUrl = config.PUBLIC_BASE_URL;
  const adminToken = config.ADMIN_TOKEN;
  const monitor = adminToken
    ? createQueueMonitor(redis, warn('redis connection error'), { prefix })
    : undefined;

  const app = await buildApp({
    config,
    rateLimit: { perMinute: config.RATE_LIMIT_PER_MINUTE, redis },
    readinessChecks: {
      database: async () => {
        await db.$queryRaw`SELECT 1`;
      },
      redis: async () => {
        await redis.ping();
      },
    },
    formAdapters,
    captureLead: createCaptureLead(db, queue),
    replyAdapters,
    handleInbound: createHandleInbound({
      db,
      queue,
      optOutKeywords: contactConfig.replies.optOutKeywords,
      salesAlertEmail: config.SALES_ALERT_EMAIL,
      repAlertTemplate: contactConfig.replies.repAlertTemplate,
    }),
    whatsappVerifyToken: config.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    unsubscribe: unsubscribeSecret
      ? {
          verify: (leadId, token) => verifyUnsubscribeToken(unsubscribeSecret, leadId, token),
          optOut: createOptOut(db),
        }
      : undefined,
    crmWebhook:
      hubspotSecret && publicBaseUrl
        ? {
            webhook: hubspotWebhook({ db, secret: hubspotSecret, config: crmConfig }),
            publicBaseUrl,
          }
        : undefined,
    admin:
      adminToken && monitor
        ? {
            token: adminToken,
            service: createAdminService({
              db,
              queue,
              monitor,
              thresholds: alertThresholds(config),
              // Erasure requests can delete contacts from the CRM.
              crm:
                crm ?? createCrmAdapter(config, pino(loggerOptions(config) || { enabled: false })),
              defaultCountry: config.DEFAULT_PHONE_COUNTRY,
              onEnqueueError: warn('resume: step not enqueued; the worker will reconcile it'),
            }),
            boardQueues: monitor.queues,
          }
        : undefined,
  });

  return {
    app,
    enabled: {
      formProviders: Object.keys(formAdapters),
      replyProviders: Object.keys(replyAdapters),
      unsubscribeLinks: Boolean(unsubscribeSecret),
      crmWebhook: Boolean(hubspotSecret && publicBaseUrl),
      admin: Boolean(adminToken),
    },
    /** Closes the app and its queues (not `db` or `redis`, which the caller owns). */
    async close() {
      await app.close();
      await queue.close();
      await monitor?.close();
    },
  };
}
