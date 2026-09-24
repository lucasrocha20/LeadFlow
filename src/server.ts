import { Redis } from 'ioredis';
import { createApi } from './api.js';
import { loadConfig } from './config.js';
import { loadContactConfig } from './contact/config.js';
import { loadCrmConfig } from './crm/config.js';
import { createDb } from './db.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
// Fail fast instead of buffering commands while Redis is down, so webhooks return an error
// (and the provider retries) rather than hanging.
const redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false });

const api = await createApi({
  config,
  db,
  contactConfig: loadContactConfig(config.CONTACT_CONFIG_PATH),
  crmConfig: loadCrmConfig(config.CRM_CONFIG_PATH),
  redis,
});
const { app } = api;

async function closeClients() {
  redis.disconnect();
  await db.$disconnect();
}

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await api.close();
  await closeClients();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(api.enabled, 'webhooks enabled');
} catch (err) {
  app.log.error(err);
  await api.close();
  await closeClients();
  process.exit(1);
}
