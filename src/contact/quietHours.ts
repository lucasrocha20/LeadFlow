const DAY = 24 * 60 * 60;

function secondsOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 3600 + m! * 60;
}

function localSecondsOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 3600 + get('minute') * 60 + get('second');
}

/**
 * Milliseconds to wait until the quiet window [start, end) is over in `timeZone`; 0 outside
 * it. Wall-clock based, so a DST change inside the window can shift the result by an hour.
 */
export function quietHoursDelayMs(
  now: Date,
  timeZone: string,
  window: { start: string; end: string },
): number {
  const t = localSecondsOfDay(now, timeZone);
  const start = secondsOfDay(window.start);
  const end = secondsOfDay(window.end);
  const quiet = start < end ? t >= start && t < end : t >= start || t < end;
  if (!quiet) return 0;
  return ((((end - t) % DAY) + DAY) % DAY) * 1000;
}
