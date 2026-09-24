import { vi } from 'vitest';
import type { AdminService } from '../src/admin/service.js';
import type { AppDeps } from '../src/app.js';
import type { JobQueue } from '../src/queue.js';

/** An in-memory JobQueue whose methods are spies. */
export function fakeQueue() {
  return {
    enqueueLeadCaptured: vi.fn<JobQueue['enqueueLeadCaptured']>(async () => {}),
    enqueueLeadQualified: vi.fn<JobQueue['enqueueLeadQualified']>(async () => {}),
    enqueueSendMessage: vi.fn<JobQueue['enqueueSendMessage']>(async () => {}),
    enqueueFollowUpStep: vi.fn<JobQueue['enqueueFollowUpStep']>(async () => {}),
    enqueueCrmSync: vi.fn<JobQueue['enqueueCrmSync']>(async () => {}),
    deadLetterCrmSync: vi.fn<JobQueue['deadLetterCrmSync']>(async () => {}),
    clearCrmDeadLetters: vi.fn<JobQueue['clearCrmDeadLetters']>(async () => {}),
    close: async () => {},
  } satisfies JobQueue;
}

const notUsed = () => Promise.reject(new Error('not used in this test'));

/** buildApp dependencies with inert defaults; override what the test exercises. */
export function testAppDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    config: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    readinessChecks: {},
    formAdapters: {},
    captureLead: notUsed,
    replyAdapters: {},
    handleInbound: notUsed,
    ...overrides,
  };
}

/** An AdminService whose methods are spies; unstubbed ones reject. */
export function fakeAdminService() {
  return {
    listLeads: vi.fn<AdminService['listLeads']>(notUsed),
    getLead: vi.fn<AdminService['getLead']>(notUsed),
    pauseEnrollment: vi.fn<AdminService['pauseEnrollment']>(notUsed),
    resumeEnrollment: vi.fn<AdminService['resumeEnrollment']>(notUsed),
    queueStats: vi.fn<AdminService['queueStats']>(notUsed),
    retryFailed: vi.fn<AdminService['retryFailed']>(notUsed),
    requeueCrmDeadLetters: vi.fn<AdminService['requeueCrmDeadLetters']>(notUsed),
    metrics: vi.fn<AdminService['metrics']>(notUsed),
    alerts: vi.fn<AdminService['alerts']>(notUsed),
    exportSubject: vi.fn<AdminService['exportSubject']>(notUsed),
    eraseSubject: vi.fn<AdminService['eraseSubject']>(notUsed),
  } satisfies AdminService;
}
