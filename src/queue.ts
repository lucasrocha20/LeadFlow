import { Queue, type DefaultJobOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Channel, LeadTier } from './generated/prisma/client.js';

export const LEAD_CAPTURED = 'lead.captured';
export const LEAD_QUALIFIED = 'lead.qualified';
export const SEND_MESSAGE = 'message.send';
export const FOLLOW_UP_STEP = 'followup.step';

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

/** What the pipeline needs from the job queue. Tests pass an in-memory fake. */
export interface JobQueue {
  enqueueLeadCaptured(job: LeadCapturedJob): Promise<void>;
  enqueueLeadQualified(job: LeadQualifiedJob): Promise<void>;
  /** `delayMs` postpones the send, e.g. until quiet hours end. */
  enqueueSendMessage(job: SendMessageJob, opts?: { delayMs?: number }): Promise<void>;
  /** Delayed until `job.runAt`. */
  enqueueFollowUpStep(job: FollowUpStepJob): Promise<void>;
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
  const queues = [leadCaptured, leadQualified, sendMessage, followUpStep];
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
    async close() {
      await Promise.all(queues.map((q) => q.close()));
    },
  };
}
