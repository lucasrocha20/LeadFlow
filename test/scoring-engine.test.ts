import { describe, expect, it } from 'vitest';
import { buildFacts, evaluate, scoreLead, type ScorableLead } from '../src/qualification/engine.js';
import { loadScoringRules, parseScoringRules, type Condition } from '../src/qualification/rules.js';

function lead(overrides: Partial<ScorableLead> = {}): ScorableLead {
  return {
    source: 'typeform',
    firstName: 'Ana',
    lastName: 'Souza',
    email: 'ana@gmail.com',
    phone: null,
    company: null,
    timezone: null,
    utm: null,
    fields: {},
    consentEmail: true,
    consentMessaging: false,
    ...overrides,
  };
}

const noFreeDomains = { freeEmailDomains: [] };

describe('buildFacts', () => {
  it('derives emailDomain and emailType', () => {
    const rules = { freeEmailDomains: ['gmail.com'] };
    expect(buildFacts(lead(), rules)).toMatchObject({
      emailDomain: 'gmail.com',
      emailType: 'free',
    });
    expect(buildFacts(lead({ email: 'ana@acme.com' }), rules)).toMatchObject({
      emailDomain: 'acme.com',
      emailType: 'business',
    });
    expect(buildFacts(lead({ email: null }), rules)).toMatchObject({
      emailDomain: null,
      emailType: 'none',
    });
  });

  it('joins names, company, email and nested text answers into `text`', () => {
    const facts = buildFacts(
      lead({ company: 'Acme', fields: { message: 'hello', tags: ['a', 'b'], size: 10 } }),
      noFreeDomains,
    );
    expect(facts['text']).toBe('Ana\nSouza\nAcme\nana@gmail.com\nhello\na\nb');
  });
});

describe('evaluate', () => {
  const facts = buildFacts(
    lead({
      phone: '+5511987654321',
      utm: { source: 'Google' },
      fields: { budget: '15000', size: 120, interests: ['CRM', 'WhatsApp'], empty: [] },
    }),
    noFreeDomains,
  );
  const check = (when: Condition) => evaluate(when, facts);

  it('eq compares strings case-insensitively and other values strictly', () => {
    expect(check({ fact: 'utm.source', op: 'eq', value: 'google' })).toBe(true);
    expect(check({ fact: 'consentEmail', op: 'eq', value: true })).toBe(true);
    expect(check({ fact: 'fields.size', op: 'eq', value: '120' })).toBe(false);
  });

  it('in matches any listed value, and any element of a multi-select answer', () => {
    expect(check({ fact: 'source', op: 'in', value: ['website', 'typeform'] })).toBe(true);
    expect(check({ fact: 'fields.interests', op: 'in', value: ['whatsapp'] })).toBe(true);
    expect(check({ fact: 'fields.interests', op: 'eq', value: 'Email' })).toBe(false);
  });

  it('numeric comparisons accept numbers and numeric strings only', () => {
    expect(check({ fact: 'fields.budget', op: 'gte', value: 15000 })).toBe(true);
    expect(check({ fact: 'fields.budget', op: 'gt', value: 15000 })).toBe(false);
    expect(check({ fact: 'fields.size', op: 'lt', value: 200 })).toBe(true);
    expect(check({ fact: 'fields.size', op: 'lte', value: 119 })).toBe(false);
    expect(check({ fact: 'firstName', op: 'gte', value: 0 })).toBe(false);
    expect(check({ fact: 'fields.missing', op: 'lt', value: 1 })).toBe(false);
  });

  it('exists treats null, missing, empty strings and empty arrays as absent', () => {
    expect(check({ fact: 'phone', op: 'exists', value: true })).toBe(true);
    expect(check({ fact: 'company', op: 'exists', value: false })).toBe(true);
    expect(check({ fact: 'fields.empty', op: 'exists', value: false })).toBe(true);
    expect(check({ fact: 'fields.nope.deeper', op: 'exists', value: false })).toBe(true);
  });

  it('matches uses a case-insensitive regex by default', () => {
    expect(check({ fact: 'email', op: 'matches', value: '@GMAIL\\.com$' })).toBe(true);
    expect(check({ fact: 'email', op: 'matches', value: '@GMAIL\\.com$', flags: '' })).toBe(false);
    expect(check({ fact: 'fields.size', op: 'matches', value: '120' })).toBe(false);
  });

  it('combines conditions with all / any / not', () => {
    const phone: Condition = { fact: 'phone', op: 'exists', value: true };
    const company: Condition = { fact: 'company', op: 'exists', value: true };
    expect(check({ all: [phone, company] })).toBe(false);
    expect(check({ any: [phone, company] })).toBe(true);
    expect(check({ not: company })).toBe(true);
  });

  it('does not read inherited properties as facts', () => {
    expect(check({ fact: 'fields.constructor', op: 'exists', value: true })).toBe(false);
  });
});

describe('scoreLead', () => {
  const rules = parseScoringRules({
    tiers: { hot: 30, warm: 10 },
    rules: [
      { id: 'phone', points: 10, when: { fact: 'phone', op: 'exists', value: true } },
      { id: 'company', points: 20, when: { fact: 'company', op: 'exists', value: true } },
      { id: 'no-budget', points: -5, when: { fact: 'fields.budget', op: 'exists', value: false } },
    ],
    disqualifiers: [
      { id: 'spam', when: { fact: 'text', op: 'matches', value: 'casino' } },
      { id: 'no-email', when: { fact: 'email', op: 'exists', value: false } },
    ],
  });

  it('sums the points of matching rules, including negative ones', () => {
    const result = scoreLead(lead({ phone: '+5511987654321' }), rules);
    expect(result).toEqual({
      score: 5,
      tier: 'cold',
      matchedRules: [
        { id: 'phone', points: 10 },
        { id: 'no-budget', points: -5 },
      ],
      disqualifiedBy: [],
    });
  });

  it.each([
    [{ fields: { budget: 1 } }, 0, 'cold'],
    [{ phone: '+5511987654321', fields: { budget: 1 } }, 10, 'warm'],
    [{ company: 'Acme', fields: { budget: 1 } }, 20, 'warm'],
    [{ phone: '+5511987654321', company: 'Acme', fields: { budget: 1 } }, 30, 'hot'],
  ] as const)('maps %j to score %i → %s using the thresholds', (overrides, score, tier) => {
    expect(scoreLead(lead(overrides), rules)).toMatchObject({ score, tier });
  });

  it('disqualifies on any disqualifier, whatever the score, and lists them all', () => {
    const result = scoreLead(
      lead({ email: null, phone: '+5511987654321', company: 'Casino Royale' }),
      rules,
    );
    expect(result.score).toBe(25);
    expect(result.tier).toBe('disqualified');
    expect(result.disqualifiedBy).toEqual(['spam', 'no-email']);
  });
});

// One matching and one non-matching lead for every rule in config/scoring.json.
describe('default rules (config/scoring.json)', () => {
  const rules = loadScoringRules('config/scoring.json');
  const matched = (l: ScorableLead) => {
    const { matchedRules, disqualifiedBy } = scoreLead(l, rules);
    return [...matchedRules.map((r) => r.id), ...disqualifiedBy];
  };

  const cases: Record<string, [Partial<ScorableLead>, Partial<ScorableLead>]> = {
    'business-email': [{ email: 'ana@acme.com.br' }, { email: 'ana@hotmail.com' }],
    'valid-phone': [{ phone: '+5511987654321' }, { phone: null }],
    'has-company': [{ company: 'Acme' }, { company: null }],
    'budget-high': [{ fields: { budget: 10000 } }, { fields: { budget: 9999 } }],
    'budget-mid': [{ fields: { budget: '5k-10k' } }, { fields: { budget: 10000 } }],
    'company-size-mid-large': [
      { fields: { company_size: '200-1000' } },
      { fields: { company_size: '1-10' } },
    ],
    'source-website': [{ source: 'website' }, { source: 'typeform' }],
    'paid-campaign': [{ utm: { medium: 'CPC' } }, { utm: { medium: 'organic' } }],
    'no-valid-contact': [
      { email: null, phone: null },
      { email: null, phone: '+5511987654321' },
    ],
    'no-consent': [
      { consentEmail: false, consentMessaging: false },
      { consentEmail: false, consentMessaging: true },
    ],
    'blocked-domain': [{ email: 'x@mailinator.com' }, { email: 'x@acme.com' }],
    'spam-content': [
      { fields: { message: 'Best SEO services and backlinks' } },
      { fields: { message: 'We need a CRM integration' } },
    ],
  };

  it('has a case for every rule and disqualifier', () => {
    const ids = [...rules.rules, ...rules.disqualifiers].map((r) => r.id).sort();
    expect(Object.keys(cases).sort()).toEqual(ids);
  });

  it.each(Object.entries(cases))('%s', (id, [matching, notMatching]) => {
    expect(matched(lead(matching))).toContain(id);
    expect(matched(lead(notMatching))).not.toContain(id);
  });

  it('budget-mid also matches numeric budgets from 5000 up to 10000', () => {
    expect(matched(lead({ fields: { budget: 5000 } }))).toContain('budget-mid');
    expect(matched(lead({ fields: { budget: '9999.5' } }))).toContain('budget-mid');
    expect(matched(lead({ fields: { budget: 4999 } }))).not.toContain('budget-mid');
  });
});
