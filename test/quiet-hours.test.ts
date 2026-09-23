import { describe, expect, it } from 'vitest';
import { quietHoursDelayMs } from '../src/contact/quietHours.js';

const MIN = 60_000;
const overnight = { start: '21:00', end: '08:00' };

describe('quietHoursDelayMs', () => {
  // São Paulo is UTC-3 all year (no DST since 2019).
  const sp = (localTime: string) => new Date(`2026-09-23T${localTime}:00-03:00`);

  it('is 0 outside an overnight window', () => {
    expect(quietHoursDelayMs(sp('08:00'), 'America/Sao_Paulo', overnight)).toBe(0);
    expect(quietHoursDelayMs(sp('14:30'), 'America/Sao_Paulo', overnight)).toBe(0);
    expect(quietHoursDelayMs(sp('20:59'), 'America/Sao_Paulo', overnight)).toBe(0);
  });

  it('waits until the end of an overnight window, before and after midnight', () => {
    expect(quietHoursDelayMs(sp('21:00'), 'America/Sao_Paulo', overnight)).toBe(11 * 60 * MIN);
    expect(quietHoursDelayMs(sp('23:30'), 'America/Sao_Paulo', overnight)).toBe(8.5 * 60 * MIN);
    expect(quietHoursDelayMs(sp('07:59'), 'America/Sao_Paulo', overnight)).toBe(1 * MIN);
  });

  it("uses the lead's time zone", () => {
    const noonUtc = new Date('2026-09-23T12:00:00Z');
    expect(quietHoursDelayMs(noonUtc, 'America/Sao_Paulo', overnight)).toBe(0); // 09:00
    expect(quietHoursDelayMs(noonUtc, 'Asia/Tokyo', overnight)).toBe(11 * 60 * MIN); // 21:00
    expect(quietHoursDelayMs(noonUtc, 'Asia/Kolkata', overnight)).toBe(0); // 17:30
  });

  it('supports a window within one day', () => {
    const lunch = { start: '12:00', end: '13:30' };
    expect(quietHoursDelayMs(sp('12:15'), 'America/Sao_Paulo', lunch)).toBe(75 * MIN);
    expect(quietHoursDelayMs(sp('13:30'), 'America/Sao_Paulo', lunch)).toBe(0);
    expect(quietHoursDelayMs(sp('11:59'), 'America/Sao_Paulo', lunch)).toBe(0);
  });
});
