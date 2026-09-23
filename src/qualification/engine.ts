import type { Lead, LeadTier } from '../generated/prisma/client.js';
import type { Condition, ScoringRules } from './rules.js';

/** The lead data rules can see. A `Lead` row fits; so does a captured `LeadInput`. */
export type ScorableLead = Pick<
  Lead,
  | 'source'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'company'
  | 'timezone'
  | 'consentEmail'
  | 'consentMessaging'
> & { utm: unknown; fields: unknown };

export type Facts = Record<string, unknown>;

export interface ScoreResult {
  score: number;
  tier: LeadTier;
  matchedRules: { id: string; points: number }[];
  disqualifiedBy: string[];
}

function collectText(value: unknown, out: string[]) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectText(v, out));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((v) => collectText(v, out));
}

/**
 * The values rules can refer to: every lead column by name (`utm.source` and `fields.<name>`
 * reach inside the JSON columns), plus derived facts:
 * - `emailDomain`: the part after the @
 * - `emailType`: "business", "free" (listed in `freeEmailDomains`) or "none"
 * - `text`: names, company, email and every text answer joined together, for spam patterns
 */
export function buildFacts(
  lead: ScorableLead,
  rules: Pick<ScoringRules, 'freeEmailDomains'>,
): Facts {
  const emailDomain = lead.email?.split('@')[1] ?? null;
  const emailType = !emailDomain
    ? 'none'
    : rules.freeEmailDomains.includes(emailDomain)
      ? 'free'
      : 'business';

  const text: string[] = [];
  collectText([lead.firstName, lead.lastName, lead.company, lead.email, lead.fields], text);

  return { ...lead, emailDomain, emailType, text: text.join('\n') };
}

function resolveFact(facts: Facts, path: string): unknown {
  let value: unknown = facts;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

// Strings compare case-insensitively, so "Gmail.com" and "gmail.com" are the same domain.
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

const regexCache = new WeakMap<object, RegExp>();

function regexFor(cond: { value: string; flags?: string }): RegExp {
  let re = regexCache.get(cond);
  if (!re) {
    re = new RegExp(cond.value, cond.flags ?? 'i');
    regexCache.set(cond, re);
  }
  return re;
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function evaluate(cond: Condition, facts: Facts): boolean {
  if ('all' in cond) return cond.all.every((c) => evaluate(c, facts));
  if ('any' in cond) return cond.any.some((c) => evaluate(c, facts));
  if ('not' in cond) return !evaluate(cond.not, facts);

  const value = resolveFact(facts, cond.fact);
  if (cond.op === 'exists') return isPresent(value) === cond.value;

  // A multi-select answer matches when any of its values does.
  const values = Array.isArray(value) ? value : [value];
  switch (cond.op) {
    case 'eq':
      return values.some((v) => same(v, cond.value));
    case 'in':
      return values.some((v) => cond.value.some((allowed) => same(v, allowed)));
    case 'matches':
      return values.some((v) => typeof v === 'string' && regexFor(cond).test(v));
    default: {
      const target = cond.value;
      return values.some((v) => {
        const n = toNumber(v);
        if (n === null) return false;
        if (cond.op === 'gt') return n > target;
        if (cond.op === 'gte') return n >= target;
        if (cond.op === 'lt') return n < target;
        return n <= target;
      });
    }
  }
}

export function scoreLead(lead: ScorableLead, rules: ScoringRules): ScoreResult {
  const facts = buildFacts(lead, rules);

  const matchedRules = rules.rules
    .filter((rule) => evaluate(rule.when, facts))
    .map(({ id, points }) => ({ id, points }));
  const score = matchedRules.reduce((sum, rule) => sum + rule.points, 0);
  const disqualifiedBy = rules.disqualifiers
    .filter((rule) => evaluate(rule.when, facts))
    .map((rule) => rule.id);

  const tier: LeadTier =
    disqualifiedBy.length > 0
      ? 'disqualified'
      : score >= rules.tiers.hot
        ? 'hot'
        : score >= rules.tiers.warm
          ? 'warm'
          : 'cold';

  return { score, tier, matchedRules, disqualifiedBy };
}
