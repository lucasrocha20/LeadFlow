import { vi } from 'vitest';
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
