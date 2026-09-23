import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createFormAdapters } from './capture/adapters/index.js';
import { createCaptureLead } from './capture/captureLead.js';
import { loadConfig } from './config.js';
import { loadContactConfig } from './contact/config.js';
import { createDb } from './db.js';
import { createReplyAdapters } from './inbound/adapters/index.js';
import { createHandleInbound } from './inbound/handleInbound.js';
import { createOptOut } from './inbound/optOut.js';
import { verifyUnsubscribeToken } from './inbound/unsubscribe.js';
import { createJobQueue } from './queue.js';

const config = loadConfig();
const contactConfig = loadContactConfig(config.CONTACT_CONFIG_PATH);
const db = createDb(config.DATABASE_URL);
// Fail fast instead of buffering commands while Redis is down, so webhooks return an error
// (and the provider retries) rather than hanging.
const redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false });
const queue = createJobQueue(redis, (err) => app.log.warn({ err }, 'redis connection error'));
const formAdapters = createFormAdapters(config);
const replyAdapters = createReplyAdapters(config);
const unsubscribeSecret = config.UNSUBSCRIBE_SECRET;

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
});

async function closeClients() {
  await queue.close();
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
    },
    'webhooks enabled',
  );
} catch (err) {
  app.log.error(err);
  await closeClients();
  process.exit(1);
}
