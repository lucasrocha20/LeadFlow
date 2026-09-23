import { Redis } from 'ioredis';
import { createAdminService } from './admin/service.js';
import { buildApp } from './app.js';
import { createFormAdapters } from './capture/adapters/index.js';
import { createCaptureLead } from './capture/captureLead.js';
import { alertThresholds, loadConfig } from './config.js';
import { loadContactConfig } from './contact/config.js';
import { loadCrmConfig } from './crm/config.js';
import { hubspotWebhook } from './crm/webhook.js';
import { createDb } from './db.js';
import { createReplyAdapters } from './inbound/adapters/index.js';
import { createHandleInbound } from './inbound/handleInbound.js';
import { createOptOut } from './inbound/optOut.js';
import { verifyUnsubscribeToken } from './inbound/unsubscribe.js';
import { createJobQueue, createQueueMonitor } from './queue.js';

const config = loadConfig();
const contactConfig = loadContactConfig(config.CONTACT_CONFIG_PATH);
const crmConfig = loadCrmConfig(config.CRM_CONFIG_PATH);
const db = createDb(config.DATABASE_URL);
// Fail fast instead of buffering commands while Redis is down, so webhooks return an error
// (and the provider retries) rather than hanging.
const redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false });
const queue = createJobQueue(redis, (err) => app.log.warn({ err }, 'redis connection error'));
const formAdapters = createFormAdapters(config);
const replyAdapters = createReplyAdapters(config);
const unsubscribeSecret = config.UNSUBSCRIBE_SECRET;
const hubspotSecret = config.CRM_PROVIDER === 'hubspot' ? config.HUBSPOT_CLIENT_SECRET : undefined;
const publicBaseUrl = config.PUBLIC_BASE_URL;
const adminToken = config.ADMIN_TOKEN;
const monitor = adminToken
  ? createQueueMonitor(redis, (err) => app.log.warn({ err }, 'redis connection error'))
  : undefined;

const app = await buildApp({
  config,
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
            onEnqueueError: (err) =>
              app.log.warn({ err }, 'resume: step not enqueued; the worker will reconcile it'),
          }),
          boardQueues: monitor.queues,
        }
      : undefined,
});

async function closeClients() {
  await queue.close();
  await monitor?.close();
  redis.disconnect();
  await db.$disconnect();
}

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closeClients();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(
    {
      formProviders: Object.keys(formAdapters),
      replyProviders: Object.keys(replyAdapters),
      unsubscribeLinks: Boolean(unsubscribeSecret),
      crmWebhook: Boolean(hubspotSecret && publicBaseUrl),
      admin: Boolean(adminToken),
    },
    'webhooks enabled',
  );
} catch (err) {
  app.log.error(err);
  await closeClients();
  process.exit(1);
}
