const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until a call fits in `max` calls per sliding `windowMs` (single process). */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const calls: number[] = [];
  return async function acquire() {
    for (;;) {
      const t = now();
      while (calls.length > 0 && calls[0]! <= t - windowMs) calls.shift();
      if (calls.length < max) {
        calls.push(t);
        return;
      }
      await sleep(calls[0]! + windowMs - t);
    }
  };
}
