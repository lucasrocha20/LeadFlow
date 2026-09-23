import { describe, expect, it, vi } from 'vitest';
import { runCrmSyncJob, type CrmJobHooks, type SyncLead } from '../src/crm/syncLead.js';
import { CrmPermanentError, CrmRateLimitError } from '../src/crm/types.js';

function run(error: Error, attemptsMade = 0) {
  const hooks = {
    deadLetter: vi.fn<CrmJobHooks['deadLetter']>(async () => {}),
    rateLimit: vi.fn<CrmJobHooks['rateLimit']>(async () => new Error('rate limited')),
  };
  const syncLead: SyncLead = () => Promise.reject(error);
  const result = runCrmSyncJob(
    syncLead,
    { data: { leadId: 'lead-1' }, attemptsMade, opts: { attempts: 3 } },
    hooks,
  ).then(
    () => new Error('expected the job to fail'),
    (e: unknown) => e as Error,
  );
  return { hooks, result };
}

describe('runCrmSyncJob', () => {
  it('pauses the queue on a rate limit without dead-lettering', async () => {
    const { hooks, result } = run(new CrmRateLimitError('429', 5_000));
    expect((await result).message).toBe('rate limited');
    expect(hooks.rateLimit).toHaveBeenCalledWith(5_000);
    expect(hooks.deadLetter).not.toHaveBeenCalled();
  });

  it('lets BullMQ retry transient errors until the last attempt', async () => {
    const early = run(new Error('502'), 0);
    expect((await early.result).message).toBe('502');
    expect(early.hooks.deadLetter).not.toHaveBeenCalled();

    const last = run(new Error('502'), 2);
    expect((await last.result).name).toBe('UnrecoverableError');
    expect(last.hooks.deadLetter).toHaveBeenCalledWith('lead-1', expect.any(Error));
  });

  it('dead-letters permanent errors right away', async () => {
    const { hooks, result } = run(new CrmPermanentError('400 invalid property'));
    expect((await result).name).toBe('UnrecoverableError');
    expect(hooks.deadLetter).toHaveBeenCalledOnce();
  });
});
