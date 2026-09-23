import { Worker, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createMessageAdapters } from './contact/adapters/index.js';
import { loadContactConfig, referencedTemplates } from './contact/config.js';
import { createPlanFirstContact } from './contact/planFirstContact.js';
import { createSendMessage, runSendMessageJob } from './contact/sendMessage.js';
import { createDb } from './db.js';
import { loggerOptions } from './logger.js';
import { createQualifyLead } from './qualification/qualifyLead.js';
import { loadScoringRules } from './qualification/rules.js';
import {
  LEAD_CAPTURED,
  LEAD_QUALIFIED,
  SEND_MESSAGE,
  createJobQueue,
  type LeadCapturedJob,
  type LeadQualifiedJob,
  type SendMessageJob,
} from './queue.js';

// Background worker: consumes pipeline jobs. Runs as its own process, next to the API.
const config = loadConfig();
const log = pino(loggerOptions(config) || { enabled: false });
const rules = loadScoringRules(config.SCORING_RULES_PATH);
const contactConfig = loadContactConfig(config.CONTACT_CONFIG_PATH);
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
  if (problems.length > 0) {
    await db.$disconnect();
    throw new Error(
      `${config.CONTACT_CONFIG_PATH} refers to templates that don't match the database ` +
        `(\`npm run db:seed\` creates the defaults):\n- ${problems.join('\n- ')}`,
    );
  }
}

// Producer connection: fail fast so the job fails and BullMQ retries it later.
const redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false });
const queue = createJobQueue(redis, (err) => log.warn({ err }, 'redis connection error'));
// Workers use blocking commands, which BullMQ requires to retry indefinitely.
const workerConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

const adapters = createMessageAdapters(config, log);
const qualifyLead = createQualifyLead(db, queue, rules);
const planFirstContact = createPlanFirstContact({
  db,
  queue,
  config: contactConfig,
  adapters,
  salesAlertEmail: config.SALES_ALERT_EMAIL,
});
const sendMessage = createSendMessage({ db, adapters });

function startWorker<T>(name: string, processor: Processor<T>, concurrency: number) {
  const worker = new Worker<T>(name, processor, { connection: workerConnection, concurrency });
  worker.on('failed', (job, err) => {
    log.error({ err, queue: name, jobId: job?.id, attempts: job?.attemptsMade }, 'job failed');
  });
  worker.on('error', (err) => log.error({ err, queue: name }, 'worker error'));
  return worker;
}

const workers = [
  startWorker<LeadCapturedJob>(
    LEAD_CAPTURED,
    async (job) => {
      const result = await qualifyLead(job.data);
      if (!result) {
        log.warn({ jobId: job.id, leadId: job.data.leadId }, 'lead not found; skipped');
        return;
      }
      const { leadId, score, tier, disqualifiedBy, duplicate } = result;
      log.info({ jobId: job.id, leadId, score, tier, disqualifiedBy, duplicate }, 'lead scored');
    },
    5,
  ),

  startWorker<LeadQualifiedJob>(
    LEAD_QUALIFIED,
    async (job) => {
      const plan = await planFirstContact(job.data);
      if (!plan) {
        log.warn({ jobId: job.id, leadId: job.data.leadId }, 'lead not found; skipped');
        return;
      }
      log.info({ jobId: job.id, ...plan }, 'first contact planned');
    },
    5,
  ),

  startWorker<SendMessageJob>(
    SEND_MESSAGE,
    async (job) => {
      const { leadId, kind, channel, template } = job.data;
      const outcome = await runSendMessageJob(sendMessage, job);
      log.info({ jobId: job.id, leadId, kind, channel, template, ...outcome }, 'message job done');
    },
    10,
  ),
];

log.info(
  {
    queues: [LEAD_CAPTURED, LEAD_QUALIFIED, SEND_MESSAGE],
    email: adapters.email?.provider,
    whatsapp: adapters.whatsapp?.provider,
    salesAlerts: Boolean(config.SALES_ALERT_EMAIL),
  },
  'worker started',
);

async function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  await Promise.all(workers.map((w) => w.close()));
  await queue.close();
  redis.disconnect();
  workerConnection.disconnect();
  await db.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
