import type { CountryCode } from 'libphonenumber-js';
import { normalizeEmail, normalizePhone } from '../capture/normalize.js';
import { requeueDeadLetters } from '../crm/syncLead.js';
import type { CrmAdapter } from '../crm/types.js';
import type { Db } from '../db.js';
import { pauseEnrollment, resumeEnrollment, type PauseOutcome } from '../followup/enrollment.js';
import {
  eraseLeads,
  exportSubject,
  findSubjectLeadIds,
  type ErasureResult,
  type Subject,
} from '../privacy/erasure.js';
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
  exportSubject(subject: RawSubject): ReturnType<typeof exportSubject>;
  /** Erases the subject's leads (and/or the given leads) and suppresses their addresses. */
  eraseSubject(request: {
    subject?: RawSubject;
    leadIds?: string[];
    deleteFromCrm: boolean;
  }): Promise<ErasureResult>;
}

/** Email and/or phone as the requester gave them; normalized like form submissions. */
export interface RawSubject {
  email?: string;
  phone?: string;
}

/** An email or phone that doesn't parse, so it could never match a lead. */
export class InvalidSubjectError extends Error {}

export function createAdminService({
  db,
  queue,
  monitor,
  thresholds,
  crm,
  defaultCountry,
  onEnqueueError = () => {},
}: {
  db: Db;
  crm: CrmAdapter;
  defaultCountry: CountryCode;
  queue: Pick<JobQueue, 'enqueueFollowUpStep' | 'enqueueCrmSync' | 'clearCrmDeadLetters'>;
  monitor: Pick<QueueMonitor, 'stats' | 'retryFailed'>;
  thresholds: AlertThresholds;
  onEnqueueError?: (err: unknown) => void;
}): AdminService {
  function normalizeSubject(raw: RawSubject): Subject {
    const email = raw.email === undefined ? null : normalizeEmail(raw.email);
    const phone = raw.phone === undefined ? null : normalizePhone(raw.phone, defaultCountry);
    if (raw.email !== undefined && !email) throw new InvalidSubjectError('Invalid email');
    if (raw.phone !== undefined && !phone) throw new InvalidSubjectError('Invalid phone');
    return { email, phone };
  }

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
    exportSubject: (raw) => exportSubject(db, normalizeSubject(raw)),
    async eraseSubject({ subject: raw, leadIds = [], deleteFromCrm }) {
      const subject = raw ? normalizeSubject(raw) : undefined;
      const ids = [
        ...new Set([...leadIds, ...(subject ? await findSubjectLeadIds(db, subject) : [])]),
      ];
      return eraseLeads(db, ids, {
        reason: 'request',
        crm: deleteFromCrm ? crm : undefined,
        extraSubject: subject,
      });
    },
  };
}
