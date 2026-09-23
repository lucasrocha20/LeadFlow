import { vi } from 'vitest';
import type { JobQueue } from '../src/queue.js';

/** An in-memory JobQueue whose methods are spies. */
export function fakeQueue() {
  return {
    enqueueLeadCaptured: vi.fn<JobQueue['enqueueLeadCaptured']>(async () => {}),
    enqueueLeadQualified: vi.fn<JobQueue['enqueueLeadQualified']>(async () => {}),
    enqueueSendMessage: vi.fn<JobQueue['enqueueSendMessage']>(async () => {}),
    close: async () => {},
  } satisfies JobQueue;
}
