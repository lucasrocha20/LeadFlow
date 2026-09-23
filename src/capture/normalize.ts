import { createHash, timingSafeEqual } from 'node:crypto';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import type { Utm } from './types.js';

export function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed : null;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email && z.email().safeParse(email).success ? email : null;
}

export function normalizePhone(
  value: string | null | undefined,
  defaultCountry: CountryCode,
): string | null {
  if (!value?.trim()) return null;
  const phone = parsePhoneNumberFromString(value, defaultCountry);
  return phone?.isValid() ? phone.number : null;
}

/** "Maria da Silva" → { firstName: "Maria", lastName: "da Silva" } */
export function splitName(fullName: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
} {
  const name = cleanText(fullName);
  if (!name) return { firstName: null, lastName: null };
  const space = name.indexOf(' ');
  if (space === -1) return { firstName: name, lastName: null };
  return { firstName: name.slice(0, space), lastName: name.slice(space + 1) };
}

/** Uses explicit first/last names when given, otherwise splits the full name. */
export function resolveName(parts: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
}): { firstName: string | null; lastName: string | null } {
  const firstName = cleanText(parts.firstName);
  const lastName = cleanText(parts.lastName);
  if (firstName || lastName) return { firstName, lastName };
  return splitName(parts.fullName);
}

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;

/** Reads `utm_source`… or `source`… keys; returns null when none is set. */
export function pickUtm(values: Record<string, unknown> | null | undefined): Utm | null {
  if (!values) return null;
  const utm: Utm = {};
  for (const key of UTM_KEYS) {
    const value = values[`utm_${key}`] ?? values[key];
    const text = typeof value === 'string' ? cleanText(value) : null;
    if (text) utm[key] = text;
  }
  return Object.keys(utm).length > 0 ? utm : null;
}

export function normalizeTimezone(value: string | null | undefined): string | null {
  const tz = cleanText(value);
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** Constant-time string comparison (hashing first so lengths always match). */
export function safeEqual(a: string, b: string): boolean {
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
