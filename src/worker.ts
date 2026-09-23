import { Worker, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createMessageAdapters } from './contact/adapters/index.js';
import { followUpSequences, loadContactConfig, referencedTemplates } from './contact/config.js';
import { createPlanFirstContact } from './contact/planFirstContact.js';
import { createSendMessage, runSendMessageJob } from './contact/sendMessage.js';
import { createDb } from './db.js';
import { reconcileEnrollments } from './followup/enrollment.js';
import { createRunFollowUpStep } from './followup/runStep.js';
import { unsubscribeUrl } from './inbound/unsubscribe.js';
import { loggerOptions } from './logger.js';
import { createQualifyLead } from './qualification/qualifyLead.js';
import { loadScoringRules } from './qualification/rules.js';
import {
  FOLLOW_UP_STEP,
  LEAD_CAPTURED,
  LEAD_QUALIFIED,
  SEND_MESSAGE,
  createJobQueue,
  type FollowUpStepJob,
  type LeadCapturedJob,
  type LeadQualifiedJob,
  type SendMessageJob,
} from './queue.js';

// Background worker: consumes pipeline jobs. Runs as its own process, next to the API.
const config = loadConfig();
const log = pino(loggerOptions(config) || { enabled: false });
const rules = loadScoringRules(config.SCORING_RULES_PATH);
const contactConfig = loadContactConfig(config.CONTACT_CONFIG_PATH);
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
const unsubscribeSecret = config.UNSUBSCRIBE_SECRET;
const baseUrl = config.PUBLIC_BASE_URL;
const sendMessage = createSendMessage({
  db,
  adapters,
  queue,
  followUpSequences: sequences,
  unsubscribeUrl:
    baseUrl && unsubscribeSecret
      ? (leadId) => unsubscribeUrl(baseUrl, unsubscribeSecret, leadId)
      : undefined,
});
const runFollowUpStep = createRunFollowUpStep({
  db,
  queue,
  quietHours: contactConfig.quietHours,
});

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

  startWorker<FollowUpStepJob>(
    FOLLOW_UP_STEP,
    async (job) => {
      const outcome = await runFollowUpStep(job.data);
      log.info({ jobId: job.id, ...job.data, ...outcome }, 'follow-up step done');
    },
    5,
  ),
];

// The database holds the follow-up schedule (Enrollment.nextRunAt). Rebuild the near-term
// part of it in Redis now and periodically, in case jobs were lost (Redis restart, failed
// enqueue). Existing jobs are left alone thanks to deterministic job ids.
const RECONCILE_EVERY_MS = 10 * 60_000;
async function reconcile() {
  try {
    const count = await reconcileEnrollments(db, (job) => queue.enqueueFollowUpStep(job), {
      horizonMs: 2 * RECONCILE_EVERY_MS,
    });
    log.debug({ enrollments: count }, 'follow-up schedule reconciled');
  } catch (err) {
    log.error({ err }, 'follow-up reconcile failed');
  }
}
await reconcile();
const reconcileTimer = setInterval(() => void reconcile(), RECONCILE_EVERY_MS);

log.info(
  {
    queues: [LEAD_CAPTURED, LEAD_QUALIFIED, SEND_MESSAGE, FOLLOW_UP_STEP],
    email: adapters.email?.provider,
    whatsapp: adapters.whatsapp?.provider,
    salesAlerts: Boolean(config.SALES_ALERT_EMAIL),
    followUpSequences: sequences,
    unsubscribeLinks: Boolean(baseUrl && unsubscribeSecret),
  },
  'worker started',
);

async function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  clearInterval(reconcileTimer);
  await Promise.all(workers.map((w) => w.close()));
  await queue.close();
  redis.disconnect();
  workerConnection.disconnect();
  await db.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
