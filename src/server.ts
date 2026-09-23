import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

const app = await buildApp({
  config,
  readinessChecks: {
    database: async () => {
      await db.$queryRaw`SELECT 1`;
    },
  },
});

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  app.log.error(err);
  await db.$disconnect();
  process.exit(1);
}
