import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export const LEAD_CAPTURED = 'lead.captured';

export interface LeadCapturedJob {
  leadId: string;
  /** The `captured` LeadEvent; also used as the job id so re-enqueueing is a no-op. */
  eventId: string;
}

/** What the pipeline needs from the job queue. Tests pass an in-memory fake. */
export interface JobQueue {
  enqueueLeadCaptured(job: LeadCapturedJob): Promise<void>;
  close(): Promise<void>;
}

export function createJobQueue(connection: Redis): JobQueue {
  const leadCaptured = new Queue<LeadCapturedJob>(LEAD_CAPTURED, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      // Keep finished jobs for a day so a replayed webhook's re-enqueue is deduped by job id.
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  });

  return {
    async enqueueLeadCaptured(job) {
      await leadCaptured.add(LEAD_CAPTURED, job, { jobId: job.eventId });
    },
    close: () => leadCaptured.close(),
  };
}
