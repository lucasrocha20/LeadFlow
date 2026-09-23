import { describe, expect, it } from 'vitest';
import {
  normalizeEmail,
  normalizePhone,
  normalizeTimezone,
  pickUtm,
  resolveName,
  safeEqual,
  splitName,
} from '../src/capture/normalize.js';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
  });

  it.each([undefined, null, '', '   ', 'not-an-email', 'a@b'])('returns null for %j', (value) => {
    expect(normalizeEmail(value)).toBeNull();
  });
});

describe('normalizePhone', () => {
  it('converts a national number using the default country', () => {
    expect(normalizePhone('(11) 98765-4321', 'BR')).toBe('+5511987654321');
  });

  it('keeps the country of an international number', () => {
    expect(normalizePhone('+1 (415) 555-2671', 'BR')).toBe('+14155552671');
  });

  it.each([undefined, '', '123', 'call me'])('returns null for %j', (value) => {
    expect(normalizePhone(value, 'BR')).toBeNull();
  });
});

describe('splitName / resolveName', () => {
  it('splits on the first space and collapses whitespace', () => {
    expect(splitName('  Maria   da  Silva ')).toEqual({ firstName: 'Maria', lastName: 'da Silva' });
  });

  it('handles a single name', () => {
    expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: null });
  });

  it('prefers explicit first/last names over the full name', () => {
    expect(
      resolveName({ firstName: 'Ana', lastName: ' Souza ', fullName: 'Other Person' }),
    ).toEqual({
      firstName: 'Ana',
      lastName: 'Souza',
    });
  });

  it('falls back to the full name', () => {
    expect(resolveName({ firstName: ' ', fullName: 'Ana Souza' })).toEqual({
      firstName: 'Ana',
      lastName: 'Souza',
    });
  });
});

describe('pickUtm', () => {
  it('accepts utm_-prefixed and bare keys, skipping empty values', () => {
    expect(pickUtm({ utm_source: 'google', medium: 'cpc', utm_term: ' ', other: 'x' })).toEqual({
      source: 'google',
      medium: 'cpc',
    });
  });

  it('returns null when nothing is set', () => {
    expect(pickUtm({ page: '/pricing' })).toBeNull();
    expect(pickUtm(undefined)).toBeNull();
  });
});

describe('normalizeTimezone', () => {
  it('accepts IANA zones and rejects junk', () => {
    expect(normalizeTimezone('America/Sao_Paulo')).toBe('America/Sao_Paulo');
    expect(normalizeTimezone('Mars/Olympus')).toBeNull();
  });
});

describe('safeEqual', () => {
  it('compares strings of any length', () => {
    expect(safeEqual('secret', 'secret')).toBe(true);
    expect(safeEqual('secret', 'secret2')).toBe(false);
  });
});
