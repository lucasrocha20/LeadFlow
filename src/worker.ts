import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { followUpSequences, loadContactConfig, referencedTemplates } from './contact/config.js';
import { loadCrmConfig } from './crm/config.js';
import { createDb } from './db.js';
import { loggerOptions } from './logger.js';
import { startPipeline } from './pipeline.js';
import { loadScoringRules } from './qualification/rules.js';

// Background worker: consumes pipeline jobs. Runs as its own process, next to the API.
const config = loadConfig();
const log = pino(loggerOptions(config) || { enabled: false });
const rules = loadScoringRules(config.SCORING_RULES_PATH);
const contactConfig = loadContactConfig(config.CONTACT_CONFIG_PATH);
const crmConfig = loadCrmConfig(config.CRM_CONFIG_PATH);
const sequences = followUpSequences(contactConfig);
const db = createDb(config.DATABASE_URL);

// Fail at startup instead of failing every message later.
{
  const expected = referencedTemplates(contactConfig);
  const found = await db.template.findMany({ where: { name: { in: [...expected.keys()] } } });
  const problems = [...expected].flatMap(([name, channel]) => {
    const template = found.find((t) => t.name === name);
    if (!template) return [`missing template "${name}"`];
    if (template.channel !== channel) return [`template "${name}" is not a ${channel} template`];
    return [];
  });
  const sequenceNames = [...new Set(Object.values(sequences))];
  const foundSequences = await db.sequence.findMany({ where: { name: { in: sequenceNames } } });
  for (const name of sequenceNames) {
    if (!foundSequences.some((s) => s.name === name)) problems.push(`missing sequence "${name}"`);
  }
  if (problems.length > 0) {
    await db.$disconnect();
    throw new Error(
      `${config.CONTACT_CONFIG_PATH} refers to templates or sequences that don't match the ` +
        `database (\`npm run db:seed\` creates the defaults):\n- ${problems.join('\n- ')}`,
    );
  }
}

// Producer connection: fail fast so the job fails and BullMQ retries it later.
const redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false });
// Workers use blocking commands, which BullMQ requires to retry indefinitely.
const workerConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

const pipeline = startPipeline({
  config,
  db,
  log,
  rules,
  contactConfig,
  crmConfig,
  redis,
  workerConnection,
});

async function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  await pipeline.close();
  redis.disconnect();
  workerConnection.disconnect();
  await db.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
