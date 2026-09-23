import { readFileSync } from 'node:fs';
import { z } from 'zod';

const statuses = [
  'new',
  'qualified',
  'contacted',
  'engaged',
  'unresponsive',
  'disqualified',
  'do_not_contact',
  'converted',
] as const;
const status = z.enum(statuses);
const properties = z.record(z.string().min(1), z.string());

const crmConfigSchema = z.strictObject({
  /** Push disqualified leads (spam, no consent…) too. */
  syncDisqualified: z.boolean(),
  /** CRM fields to set for each LeadFlow status (HubSpot: contact properties). */
  stages: z.strictObject(
    Object.fromEntries(statuses.map((s) => [s, properties])) as {
      [K in (typeof statuses)[number]]: typeof properties;
    },
  ),
  /** CRM owner id to assign new contacts to, per tier. */
  owners: z.strictObject({
    hot: z.string().min(1).optional(),
    warm: z.string().min(1).optional(),
    cold: z.string().min(1).optional(),
  }),
  /**
   * CRM → LeadFlow: when a rep sets `property` to `value` in the CRM, the lead gets `status`
   * (and its follow-up stops unless the status is still contactable).
   */
  inbound: z.array(z.strictObject({ property: z.string().min(1), value: z.string(), status })),
});

export type CrmConfig = z.infer<typeof crmConfigSchema>;

export function parseCrmConfig(data: unknown): CrmConfig {
  const result = crmConfigSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid CRM config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadCrmConfig(path: string): CrmConfig {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read CRM config from ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return parseCrmConfig(data);
}
