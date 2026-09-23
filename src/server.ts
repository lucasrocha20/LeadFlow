import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createFormAdapters } from './capture/adapters/index.js';
import { createCaptureLead } from './capture/captureLead.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createJobQueue } from './queue.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
// Fail fast instead of buffering commands while Redis is down, so webhooks return an error
// (and the provider retries) rather than hanging.
const redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false });
const queue = createJobQueue(redis);
const formAdapters = createFormAdapters(config);

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
  app.log.info({ formProviders: Object.keys(formAdapters) }, 'form webhooks enabled');
} catch (err) {
  app.log.error(err);
  await closeClients();
  process.exit(1);
}
