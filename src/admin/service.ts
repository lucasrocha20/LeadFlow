import { requeueDeadLetters } from '../crm/syncLead.js';
import type { Db } from '../db.js';
import { pauseEnrollment, resumeEnrollment, type PauseOutcome } from '../followup/enrollment.js';
import type { JobQueue, QueueMonitor, QueueStats } from '../queue.js';
import { evaluateAlerts, type Alert, type AlertThresholds } from './alerts.js';
import { getLead, listLeads, type LeadFilters } from './leads.js';
import { computeMetrics, type Metrics, type MetricsRange } from './metrics.js';

/** What the admin routes need. Tests pass a fake. */
export interface AdminService {
  listLeads(filters: LeadFilters): ReturnType<typeof listLeads>;
  getLead(leadId: string): ReturnType<typeof getLead>;
  pauseEnrollment(enrollmentId: string, reason?: string): Promise<PauseOutcome>;
  /** `queued: false` when the step job couldn't be enqueued; the reconcile sweep will. */
  resumeEnrollment(enrollmentId: string): Promise<PauseOutcome & { queued?: boolean }>;
  queueStats(): Promise<QueueStats[]>;
  retryFailed(queue: string): Promise<number | null>;
  requeueCrmDeadLetters(leadIds?: string[]): Promise<number>;
  metrics(range: MetricsRange): Promise<Metrics>;
  alerts(): Promise<Alert[]>;
}

export function createAdminService({
  db,
  queue,
  monitor,
  thresholds,
  onEnqueueError = () => {},
}: {
  db: Db;
  queue: Pick<JobQueue, 'enqueueFollowUpStep' | 'enqueueCrmSync' | 'clearCrmDeadLetters'>;
  monitor: Pick<QueueMonitor, 'stats' | 'retryFailed'>;
  thresholds: AlertThresholds;
  onEnqueueError?: (err: unknown) => void;
}): AdminService {
  return {
    listLeads: (filters) => listLeads(db, filters),
    getLead: (leadId) => getLead(db, leadId),
    pauseEnrollment: (id, reason) => pauseEnrollment(db, id, reason),
    async resumeEnrollment(id) {
      const { job, ...outcome } = await resumeEnrollment(db, id);
      if (!job) return outcome;
      try {
        await queue.enqueueFollowUpStep(job);
        return { ...outcome, queued: true };
      } catch (err) {
        onEnqueueError(err);
        return { ...outcome, queued: false };
      }
    },
    queueStats: () => monitor.stats(),
    retryFailed: (name) => monitor.retryFailed(name),
    requeueCrmDeadLetters: (leadIds) => requeueDeadLetters(db, queue, leadIds),
    metrics: (range) => computeMetrics(db, range),
    alerts: () => evaluateAlerts({ db, monitor, thresholds }),
  };
}
