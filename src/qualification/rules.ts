import { readFileSync } from 'node:fs';
import { z } from 'zod';

type Primitive = string | number | boolean;

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fact: string; op: 'eq'; value: Primitive }
  | { fact: string; op: 'in'; value: Primitive[] }
  | { fact: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number }
  | { fact: string; op: 'exists'; value: boolean }
  | { fact: string; op: 'matches'; value: string; flags?: string };

const primitive = z.union([z.string(), z.number(), z.boolean()]);
const fact = z.string().min(1);

const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(conditionSchema).min(1) }),
    z.strictObject({ any: z.array(conditionSchema).min(1) }),
    z.strictObject({ not: conditionSchema }),
    z.strictObject({ fact, op: z.literal('eq'), value: primitive }),
    z.strictObject({ fact, op: z.literal('in'), value: z.array(primitive).min(1) }),
    z.strictObject({ fact, op: z.enum(['gt', 'gte', 'lt', 'lte']), value: z.number() }),
    z.strictObject({ fact, op: z.literal('exists'), value: z.boolean() }),
    z
      .strictObject({
        fact,
        op: z.literal('matches'),
        value: z.string(),
        flags: z.string().optional(),
      })
      .refine(
        ({ value, flags }) => {
          try {
            new RegExp(value, flags ?? 'i');
            return true;
          } catch {
            return false;
          }
        },
        { message: 'Invalid regular expression' },
      ),
  ]),
);

const ruleId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Use kebab-case ids');

const scoringRulesSchema = z
  .strictObject({
    /** Minimum score for each tier; anything below `warm` is cold. */
    tiers: z.strictObject({ hot: z.number(), warm: z.number() }),
    /** Domains that make an email "free" rather than "business" (the `emailType` fact). */
    freeEmailDomains: z.array(z.string().toLowerCase()).default([]),
    rules: z.array(
      z.strictObject({
        id: ruleId,
        description: z.string().optional(),
        points: z.number(),
        when: conditionSchema,
      }),
    ),
    /** Any match puts the lead in the `disqualified` tier, whatever its score. */
    disqualifiers: z.array(
      z.strictObject({ id: ruleId, description: z.string().optional(), when: conditionSchema }),
    ),
  })
  .refine(({ tiers }) => tiers.hot > tiers.warm, {
    message: 'tiers.hot must be greater than tiers.warm',
    path: ['tiers'],
  })
  .refine(
    ({ rules, disqualifiers }) => {
      const ids = [...rules, ...disqualifiers].map((r) => r.id);
      return new Set(ids).size === ids.length;
    },
    { message: 'Rule and disqualifier ids must be unique', path: ['rules'] },
  );

export type ScoringRules = z.infer<typeof scoringRulesSchema>;

export function parseScoringRules(data: unknown): ScoringRules {
  const result = scoringRulesSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid scoring rules:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadScoringRules(path: string): ScoringRules {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read scoring rules from ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return parseScoringRules(data);
}
