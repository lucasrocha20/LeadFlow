import type { Lead } from '../generated/prisma/client.js';
import { PermanentSendError } from './adapters/types.js';

// {{name}} or {{name|fallback}}; names may use dots, e.g. {{fields.budget}}.
const VARIABLE = /\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g;

export type TemplateVars = Record<string, string | undefined>;

/** Variables in order of first appearance (WhatsApp template parameters are positional). */
export function templateVariables(text: string): { name: string; fallback?: string }[] {
  const seen = new Map<string, string | undefined>();
  for (const [, name, fallback] of text.matchAll(VARIABLE)) {
    if (!seen.has(name!)) seen.set(name!, fallback?.trim());
  }
  return [...seen].map(([name, fallback]) => ({ name, fallback }));
}

function valueOf(name: string, fallback: string | undefined, vars: TemplateVars): string {
  const value = vars[name]?.trim() || fallback;
  if (!value) {
    throw new PermanentSendError(`Template variable "${name}" has no value and no fallback`);
  }
  return value;
}

/** Fills in each `{{name}}`; a variable without a value must have a `{{name|fallback}}`. */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(VARIABLE, (_match, name: string, fallback?: string) =>
    valueOf(name, fallback?.trim(), vars),
  );
}

/** Values for the variables of `text`, in order of first appearance. */
export function templateParameters(text: string, vars: TemplateVars): string[] {
  return templateVariables(text).map(({ name, fallback }) => valueOf(name, fallback, vars));
}

type VarsLead = Pick<
  Lead,
  'firstName' | 'lastName' | 'email' | 'phone' | 'company' | 'source' | 'score' | 'tier' | 'fields'
>;

/** Variables available to templates: the lead's contact data plus `fields.<answer>`. */
export function leadTemplateVars(lead: VarsLead): TemplateVars {
  const vars: TemplateVars = {
    firstName: lead.firstName ?? undefined,
    lastName: lead.lastName ?? undefined,
    fullName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || undefined,
    email: lead.email ?? undefined,
    phone: lead.phone ?? undefined,
    company: lead.company ?? undefined,
    source: lead.source,
    score: lead.score?.toString(),
    tier: lead.tier ?? undefined,
  };
  if (lead.fields && typeof lead.fields === 'object' && !Array.isArray(lead.fields)) {
    for (const [key, value] of Object.entries(lead.fields)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        vars[`fields.${key}`] = String(value);
      } else if (Array.isArray(value)) {
        vars[`fields.${key}`] = value.filter((v) => typeof v === 'string').join(', ');
      }
    }
  }
  return vars;
}
