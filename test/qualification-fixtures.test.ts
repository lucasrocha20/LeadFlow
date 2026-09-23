import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFormAdapters } from '../src/capture/adapters/index.js';
import type { LeadTier } from '../src/generated/prisma/client.js';
import { scoreLead, type ScorableLead } from '../src/qualification/engine.js';
import { loadScoringRules } from '../src/qualification/rules.js';

const rules = loadScoringRules('config/scoring.json');
const json = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('fixture leads land in the expected tiers (default rules)', () => {
  const defaults: ScorableLead = {
    source: 'typeform',
    firstName: 'Test',
    lastName: null,
    email: null,
    phone: null,
    company: null,
    timezone: null,
    utm: null,
    fields: {},
    consentEmail: true,
    consentMessaging: true,
  };
  const fixtures = json('qualification-leads.json') as {
    name: string;
    expectedTier: LeadTier;
    lead: Partial<ScorableLead>;
  }[];

  it.each(fixtures)('$name → $expectedTier', ({ lead, expectedTier }) => {
    expect(scoreLead({ ...defaults, ...lead }, rules).tier).toBe(expectedTier);
  });
});

describe('captured webhook fixtures, scored with the default rules', () => {
  const adapters = createFormAdapters({
    DEFAULT_PHONE_COUNTRY: 'BR',
    FORM_WEBHOOK_SECRET: 'x',
    TYPEFORM_WEBHOOK_SECRET: 'x',
  });

  it.each([
    ['typeform', 'typeform.json', 95, 'hot'],
    ['website', 'website.json', 55, 'warm'],
  ])('%s (%s) scores %i → %s', (provider, file, score, tier) => {
    const adapter = adapters[provider]!;
    const input = adapter.normalize(json(file));
    expect(scoreLead({ ...input, source: adapter.source }, rules)).toMatchObject({ score, tier });
  });
});
