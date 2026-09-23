import { Queue, type DefaultJobOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Channel, LeadTier } from './generated/prisma/client.js';

export const LEAD_CAPTURED = 'lead.captured';
export const LEAD_QUALIFIED = 'lead.qualified';
export const SEND_MESSAGE = 'message.send';
export const FOLLOW_UP_STEP = 'followup.step';
export const CRM_SYNC = 'crm.sync';
/** Dead-letter queue: nothing consumes it; entries are inspected and requeued. */
export const CRM_SYNC_DEAD = 'crm.sync.dead';

export interface LeadCapturedJob {
  leadId: string;
  /** The `captured` LeadEvent; also used as the job id so re-enqueueing is a no-op. */
  eventId: string;
}

export interface LeadQualifiedJob {
  leadId: string;
  /** The `scored` LeadEvent; also the job id. */
  eventId: string;
  score: number;
  tier: Exclude<LeadTier, 'disqualified'>;
}

export interface SendMessageJob {
  leadId: string;
  kind: 'first_contact' | 'follow_up' | 'rep_alert';
  channel: Channel;
  /** Template name. */
  template: string;
  /** Rep alerts only; lead messages go to the lead's address at send time. */
  to?: string;
  /** Identifies the logical message; the `message_sent` event and the job id derive from it. */
  dedupeKey: string;
  /** Follow-ups only: the message is dropped if this enrollment is no longer active. */
  enrollmentId?: string;
  /** Extra template variables, e.g. the reply text in a rep alert. */
  vars?: Record<string, string>;
}

export interface FollowUpStepJob {
  enrollmentId: string;
  /** `SequenceStep.order` this job runs (past the last step: the completion check). */
  step: number;
  /** `Enrollment.nextRunAt` it was scheduled for, in ms. */
  runAt: number;
}

export interface CrmSyncJob {
  leadId: string;
}

export interface CrmDeadLetter {
  leadId: string;
  error: string;
  failedAt: string;
}

/** What the pipeline needs from the job queue. Tests pass an in-memory fake. */
export interface JobQueue {
  enqueueLeadCaptured(job: LeadCapturedJob): Promise<void>;
  enqueueLeadQualified(job: LeadQualifiedJob): Promise<void>;
  /** `delayMs` postpones the send, e.g. until quiet hours end. */
  enqueueSendMessage(job: SendMessageJob, opts?: { delayMs?: number }): Promise<void>;
  /** Delayed until `job.runAt`. */
  enqueueFollowUpStep(job: FollowUpStepJob): Promise<void>;
  /** At most one pending sync per lead; a sync picks up every event not synced yet. */
  enqueueCrmSync(job: CrmSyncJob): Promise<void>;
  deadLetterCrmSync(entry: CrmDeadLetter): Promise<void>;
  /** Removes dead-letter entries (all, or for these leads). */
  clearCrmDeadLetters(leadIds?: string[]): Promise<void>;
  close(): Promise<void>;
}

const defaultJobOptions: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  // Keep finished jobs for a day so a re-enqueue with the same job id is a no-op.
  removeOnComplete: { age: 24 * 60 * 60 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

// Provider hiccups get a few retries over about 2.5 minutes: 5s, 10s, 20s, 40s, 80s.
const sendMessageJobOptions: DefaultJobOptions = {
  ...defaultJobOptions,
  attempts: 6,
  backoff: { type: 'exponential', delay: 5_000 },
};

/** BullMQ job ids can't contain ':'. */
export const messageJobId = (dedupeKey: string) => dedupeKey.replaceAll(':', '_');

// A rescheduled step gets a new id, so an old completed job never blocks it.
export const followUpJobId = (job: FollowUpStepJob) =>
  `followup-${job.enrollmentId}-${job.step}-${job.runAt}`;

export function createJobQueue(
  connection: Redis,
  /** Connection errors; without a listener BullMQ prints them to stderr. */
  onError: (err: Error) => void = () => {},
): JobQueue {
  const leadCaptured = new Queue<LeadCapturedJob>(LEAD_CAPTURED, { connection, defaultJobOptions });
  const leadQualified = new Queue<LeadQualifiedJob>(LEAD_QUALIFIED, {
    connection,
    defaultJobOptions,
  });
  const sendMessage = new Queue<SendMessageJob>(SEND_MESSAGE, {
    connection,
    defaultJobOptions: sendMessageJobOptions,
  });
  const followUpStep = new Queue<FollowUpStepJob>(FOLLOW_UP_STEP, {
    connection,
    defaultJobOptions,
  });
  const crmSync = new Queue<CrmSyncJob>(CRM_SYNC, {
    connection,
    defaultJobOptions: {
      // About 4 hours of retries (30s, 1m, 2m … 32m) before dead-lettering.
      attempts: 8,
      backoff: { type: 'exponential', delay: 30_000 },
      // Free the per-lead job id right away so the next sweep can enqueue the lead again.
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  const crmDead = new Queue<CrmDeadLetter>(CRM_SYNC_DEAD, {
    connection,
    defaultJobOptions: { removeOnComplete: true },
  });
  const queues = [leadCaptured, leadQualified, sendMessage, followUpStep, crmSync, crmDead];
  for (const queue of queues) queue.on('error', onError);

  return {
    async enqueueLeadCaptured(job) {
      await leadCaptured.add(LEAD_CAPTURED, job, { jobId: job.eventId });
    },
    async enqueueLeadQualified(job) {
      await leadQualified.add(LEAD_QUALIFIED, job, { jobId: job.eventId });
    },
    async enqueueSendMessage(job, opts) {
      await sendMessage.add(SEND_MESSAGE, job, {
        jobId: messageJobId(job.dedupeKey),
        delay: opts?.delayMs,
      });
    },
    async enqueueFollowUpStep(job) {
      await followUpStep.add(FOLLOW_UP_STEP, job, {
        jobId: followUpJobId(job),
        delay: Math.max(0, job.runAt - Date.now()),
      });
    },
    async enqueueCrmSync(job) {
      await crmSync.add(CRM_SYNC, job, { jobId: `crm-sync-${job.leadId}` });
    },
    async deadLetterCrmSync(entry) {
      await crmDead.add(CRM_SYNC_DEAD, entry, {
        jobId: `crm-dead-${entry.leadId}-${Date.parse(entry.failedAt)}`,
      });
    },
    async clearCrmDeadLetters(leadIds) {
      const entries = await crmDead.getJobs(['wait', 'delayed']);
      await Promise.all(
        entries
          .filter((job) => !leadIds || leadIds.includes(job.data.leadId))
          .map((job) => job.remove()),
      );
    },
    async close() {
      await Promise.all(queues.map((q) => q.close()));
    },
  };
}

/** Queues the worker consumes (the dead-letter queue is only inspected). */
export const WORK_QUEUES = [LEAD_CAPTURED, LEAD_QUALIFIED, SEND_MESSAGE, FOLLOW_UP_STEP, CRM_SYNC];

export interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  /** How long the oldest waiting job has been waiting, in ms (0 when none). */
  oldestWaitingMs: number;
}

/** Read and repair access to the queues, for the admin API, Bull Board and alerts. */
export interface QueueMonitor {
  /** BullMQ queues, including the dead-letter queue, for Bull Board. */
  readonly queues: Queue[];
  stats(): Promise<QueueStats[]>;
  /** Moves a work queue's failed jobs back to waiting. Null for an unknown queue. */
  retryFailed(name: string): Promise<number | null>;
  close(): Promise<void>;
}

export function createQueueMonitor(
  connection: Redis,
  onError: (err: Error) => void = () => {},
  now: () => number = Date.now,
): QueueMonitor {
  const work = new Map(WORK_QUEUES.map((name) => [name, new Queue(name, { connection })]));
  const crmDead = new Queue<CrmDeadLetter>(CRM_SYNC_DEAD, { connection });
  const queues = [...work.values(), crmDead];
  for (const queue of queues) queue.on('error', onError);

  return {
    queues,
    async stats() {
      return Promise.all(
        [...work.values()].map(async (queue) => {
          const [counts, [oldest]] = await Promise.all([
            queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
            queue.getJobs(['waiting'], 0, 0, true),
          ]);
          return {
            name: queue.name,
            waiting: counts['waiting'] ?? 0,
            active: counts['active'] ?? 0,
            delayed: counts['delayed'] ?? 0,
            failed: counts['failed'] ?? 0,
            oldestWaitingMs: oldest ? Math.max(0, now() - oldest.timestamp) : 0,
          };
        }),
      );
    },
    async retryFailed(name) {
      const queue = work.get(name);
      if (!queue) return null;
      const failed = await queue.getFailedCount();
      // Every job handler is idempotent (event dedupe keys), so a retry can't double-send.
      if (failed > 0) await queue.retryJobs({ state: 'failed' });
      return failed;
    },
    async close() {
      await Promise.all(queues.map((q) => q.close()));
    },
  };
}
