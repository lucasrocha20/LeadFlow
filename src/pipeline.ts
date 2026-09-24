import { Worker, type Processor } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { evaluateAlerts, notifyAlerts, redisAlertStore, webhookSender } from './admin/alerts.js';
import { alertThresholds, type Config } from './config.js';
import { createMessageAdapters, type MessageAdapters } from './contact/adapters/index.js';
import { followUpSequences, type ContactConfig } from './contact/config.js';
import { createPlanFirstContact } from './contact/planFirstContact.js';
import { createSendMessage, runSendMessageJob } from './contact/sendMessage.js';
import { createCrmAdapter } from './crm/adapters/index.js';
import type { CrmConfig } from './crm/config.js';
import {
  createSyncLead,
  deadLetterCrmSync,
  findLeadsToSync,
  runCrmSyncJob,
} from './crm/syncLead.js';
import type { CrmAdapter } from './crm/types.js';
import type { Db } from './db.js';
import { reconcileEnrollments } from './followup/enrollment.js';
import { createRunFollowUpStep } from './followup/runStep.js';
import { unsubscribeUrl } from './inbound/unsubscribe.js';
import { eraseLeads, findExpiredLeads } from './privacy/erasure.js';
import { createQualifyLead } from './qualification/qualifyLead.js';
import type { ScoringRules } from './qualification/rules.js';
import {
  CRM_SYNC,
  FOLLOW_UP_STEP,
  LEAD_CAPTURED,
  LEAD_QUALIFIED,
  SEND_MESSAGE,
  WORK_QUEUES,
  createJobQueue,
  createQueueMonitor,
  type CrmSyncJob,
  type FollowUpStepJob,
  type LeadCapturedJob,
  type LeadQualifiedJob,
  type SendMessageJob,
} from './queue.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const RETENTION_BATCH = 500;

export interface PipelineDeps {
  config: Config;
  db: Db;
  log: Logger;
  rules: ScoringRules;
  contactConfig: ContactConfig;
  crmConfig: CrmConfig;
  /** Producer connection; fail fast (`enableOfflineQueue: false`) so jobs fail and retry. */
  redis: Redis;
  /** Worker connection; BullMQ requires `maxRetriesPerRequest: null`. */
  workerConnection: Redis;
  /** BullMQ key prefix (tests isolate their queues). */
  prefix?: string;
  /** Defaults to the providers selected in `config`. */
  messageAdapters?: MessageAdapters;
  crm?: CrmAdapter;
  /** Clock for the CRM sweep and sync (tests move it past the sync lag). */
  crmNow?: () => Date;
  /** Periodic tasks; set `false` to only run them by hand (tests). */
  intervals?:
    { reconcileMs: number; crmSweepMs: number; alertsMs: number; retentionMs: number } | false;
}

/**
 * The background pipeline: one BullMQ worker per queue plus the periodic tasks (follow-up
 * reconcile, CRM sweep, alerts, retention). `src/worker.ts` runs it as its own process.
 */
export function startPipeline(deps: PipelineDeps) {
  const { config, db, log, rules, contactConfig, crmConfig, prefix } = deps;
  const sequences = followUpSequences(contactConfig);
  const onRedisError = (err: Error) => log.warn({ err }, 'redis connection error');
  const queue = createJobQueue(deps.redis, onRedisError, { prefix });
  const monitor = createQueueMonitor(deps.redis, onRedisError, { prefix });

  const adapters = deps.messageAdapters ?? createMessageAdapters(config, log);
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
  const crm = deps.crm ?? createCrmAdapter(config, log);
  const syncLead = createSyncLead({ db, crm, config: crmConfig, now: deps.crmNow });
  const runFollowUpStep = createRunFollowUpStep({
    db,
    queue,
    quietHours: contactConfig.quietHours,
  });

  function startWorker<T>(name: string, processor: Processor<T>, concurrency: number) {
    const worker: Worker<T> = new Worker<T>(name, processor, {
      connection: deps.workerConnection,
      concurrency,
      ...(prefix && { prefix }),
    });
    worker.on('failed', (job, err) => {
      log.error({ err, queue: name, jobId: job?.id, attempts: job?.attemptsMade }, 'job failed');
    });
    worker.on('error', (err) => log.error({ err, queue: name }, 'worker error'));
    return worker;
  }

  const workers: { close(): Promise<void> }[] = [
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
        log.info(
          { jobId: job.id, leadId, kind, channel, template, ...outcome },
          'message job done',
        );
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

  // One lead at a time keeps each lead's timeline in order and stays well under CRM rate limits.
  const crmWorker: Worker<CrmSyncJob> = startWorker<CrmSyncJob>(
    CRM_SYNC,
    async (job) => {
      const outcome = await runCrmSyncJob(syncLead, job, {
        deadLetter: async (leadId, err) => {
          log.error({ err, leadId }, 'crm sync dead-lettered');
          await deadLetterCrmSync(db, queue, leadId, err);
        },
        rateLimit: async (ms) => {
          log.warn({ ms }, 'crm rate limited; pausing sync');
          await crmWorker.rateLimit(ms);
          return Worker.RateLimitError();
        },
      });
      if (outcome.status === 'synced')
        log.info({ leadId: job.data.leadId, ...outcome }, 'crm synced');
    },
    1,
  );
  workers.push(crmWorker);

  const intervals = deps.intervals ?? {
    reconcileMs: 10 * MINUTE,
    crmSweepMs: 30_000,
    alertsMs: MINUTE,
    retentionMs: 60 * MINUTE,
  };

  // The database holds the follow-up schedule (Enrollment.nextRunAt). Rebuild the near-term
  // part of it in Redis now and periodically, in case jobs were lost (Redis restart, failed
  // enqueue). Existing jobs are left alone thanks to deterministic job ids.
  async function reconcile() {
    try {
      const count = await reconcileEnrollments(db, (job) => queue.enqueueFollowUpStep(job), {
        horizonMs: 2 * (intervals ? intervals.reconcileMs : 10 * MINUTE),
      });
      log.debug({ enrollments: count }, 'follow-up schedule reconciled');
    } catch (err) {
      log.error({ err }, 'follow-up reconcile failed');
    }
  }

  // CRM sync is pull-based: find leads with events not pushed yet and queue one job per lead.
  async function crmSweep() {
    try {
      const leadIds = await findLeadsToSync(db, {
        syncDisqualified: crmConfig.syncDisqualified,
        now: deps.crmNow?.(),
      });
      for (const leadId of leadIds) await queue.enqueueCrmSync({ leadId });
      if (leadIds.length > 0) log.debug({ leads: leadIds.length }, 'crm sync queued');
      return leadIds.length;
    } catch (err) {
      log.error({ err }, 'crm sweep failed');
      return 0;
    }
  }

  // Alerts: queue backlog, failed sends, parked CRM syncs. Redis holds the cooldowns, so
  // several workers (or a restart) don't repeat a notification.
  const alertStore = redisAlertStore(deps.redis, prefix ? `${prefix}:alerts` : undefined);
  const sendAlert = config.ALERT_WEBHOOK_URL ? webhookSender(config.ALERT_WEBHOOK_URL) : undefined;
  async function checkAlerts() {
    try {
      const alerts = await evaluateAlerts({ db, monitor, thresholds: alertThresholds(config) });
      await notifyAlerts({
        alerts,
        store: alertStore,
        send: sendAlert,
        cooldownMs: config.ALERT_COOLDOWN_MINUTES * MINUTE,
        log,
      });
    } catch (err) {
      log.error({ err }, 'alert check failed');
    }
  }

  // Retention: erase leads inactive for DATA_RETENTION_DAYS, a batch at a time.
  async function runRetention(now = new Date()) {
    if (!config.DATA_RETENTION_DAYS) return 0;
    try {
      const cutoff = new Date(now.getTime() - config.DATA_RETENTION_DAYS * DAY);
      let total = 0;
      for (;;) {
        const ids = await findExpiredLeads(db, cutoff, RETENTION_BATCH);
        if (ids.length === 0) break;
        const { erased } = await eraseLeads(db, ids, { reason: 'retention' });
        total += erased;
        if (ids.length < RETENTION_BATCH || erased === 0) break;
      }
      if (total > 0) log.info({ erased: total, cutoff }, 'retention: expired leads erased');
      return total;
    } catch (err) {
      log.error({ err }, 'retention run failed');
      return 0;
    }
  }

  const timers: NodeJS.Timeout[] = [];
  if (intervals) {
    void reconcile();
    void crmSweep();
    void checkAlerts();
    void runRetention();
    timers.push(
      setInterval(() => void reconcile(), intervals.reconcileMs),
      setInterval(() => void crmSweep(), intervals.crmSweepMs),
      setInterval(() => void checkAlerts(), intervals.alertsMs),
      setInterval(() => void runRetention(), intervals.retentionMs),
    );
  }

  log.info(
    {
      queues: WORK_QUEUES,
      email: adapters.email?.provider,
      whatsapp: adapters.whatsapp?.provider,
      salesAlerts: Boolean(config.SALES_ALERT_EMAIL),
      followUpSequences: sequences,
      unsubscribeLinks: Boolean(baseUrl && unsubscribeSecret),
      crm: crm.provider,
      alertWebhook: Boolean(sendAlert),
      retentionDays: config.DATA_RETENTION_DAYS ?? null,
    },
    'worker started',
  );

  return {
    queue,
    monitor,
    reconcile,
    crmSweep,
    checkAlerts,
    runRetention,
    async close() {
      for (const timer of timers) clearInterval(timer);
      await Promise.all(workers.map((w) => w.close()));
      await queue.close();
      await monitor.close();
    },
  };
}

export type Pipeline = ReturnType<typeof startPipeline>;
