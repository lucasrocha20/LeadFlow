import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadScoringRules, parseScoringRules } from '../src/qualification/rules.js';

const minimal = {
  tiers: { hot: 50, warm: 20 },
  rules: [{ id: 'has-phone', points: 10, when: { fact: 'phone', op: 'exists', value: true } }],
  disqualifiers: [],
};

describe('loadScoringRules', () => {
  it('loads the default rules shipped in config/scoring.json', () => {
    const rules = loadScoringRules('config/scoring.json');
    expect(rules.rules.length).toBeGreaterThan(0);
    expect(rules.disqualifiers.length).toBeGreaterThan(0);
    expect(rules.freeEmailDomains).toContain('gmail.com');
  });

  it('reports a missing file or invalid JSON with the path', () => {
    expect(() => loadScoringRules('config/nope.json')).toThrow(/config\/nope\.json/);
    const dir = mkdtempSync(join(tmpdir(), 'leadflow-'));
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    expect(() => loadScoringRules(join(dir, 'bad.json'))).toThrow(/bad\.json/);
  });
});

describe('parseScoringRules', () => {
  it('accepts nested all/any/not conditions', () => {
    const rules = parseScoringRules({
      ...minimal,
      disqualifiers: [
        {
          id: 'nested',
          when: {
            all: [
              { not: { fact: 'email', op: 'exists', value: true } },
              { any: [{ fact: 'source', op: 'in', value: ['a', 'b'] }] },
            ],
          },
        },
      ],
    });
    expect(rules.disqualifiers).toHaveLength(1);
    expect(rules.freeEmailDomains).toEqual([]);
  });

  it('lowercases free email domains', () => {
    expect(
      parseScoringRules({ ...minimal, freeEmailDomains: ['GMail.com'] }).freeEmailDomains,
    ).toEqual(['gmail.com']);
  });

  it.each([
    ['hot threshold not above warm', { ...minimal, tiers: { hot: 20, warm: 20 } }, /tiers\.hot/],
    [
      'duplicate ids',
      { ...minimal, rules: [minimal.rules[0], minimal.rules[0]] },
      /ids must be unique/,
    ],
    [
      'an unknown operator',
      {
        ...minimal,
        rules: [{ id: 'x', points: 1, when: { fact: 'phone', op: 'like', value: 1 } }],
      },
      /Invalid scoring rules/,
    ],
    [
      'a typo in a rule key',
      { ...minimal, rules: [{ id: 'x', point: 1, when: minimal.rules[0]!.when }] },
      /Invalid scoring rules/,
    ],
    [
      'a numeric operator with a string value',
      { ...minimal, rules: [{ id: 'x', points: 1, when: { fact: 'f', op: 'gte', value: '10' } }] },
      /Invalid scoring rules/,
    ],
    [
      'an invalid regex',
      {
        ...minimal,
        disqualifiers: [{ id: 'x', when: { fact: 'text', op: 'matches', value: '(unclosed' } }],
      },
      /Invalid regular expression/,
    ],
    [
      'a non-kebab-case id',
      { ...minimal, rules: [{ ...minimal.rules[0], id: 'Has Phone' }] },
      /kebab-case/,
    ],
  ])('rejects %s', (_name, data, message) => {
    expect(() => parseScoringRules(data)).toThrow(message);
  });
});
