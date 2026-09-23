import { describe, expect, it } from 'vitest';
import { PermanentSendError } from '../src/contact/adapters/types.js';
import {
  leadTemplateVars,
  renderTemplate,
  templateParameters,
  templateVariables,
} from '../src/contact/templates.js';

describe('renderTemplate', () => {
  it('fills in variables, allowing spaces inside the braces', () => {
    expect(
      renderTemplate('Hi {{firstName}}, from {{ company }}!', {
        firstName: 'Ana',
        company: 'Acme',
      }),
    ).toBe('Hi Ana, from Acme!');
  });

  it('uses the fallback when the value is missing or blank', () => {
    expect(renderTemplate('Hi {{firstName|there}}', {})).toBe('Hi there');
    expect(renderTemplate('Hi {{firstName | there }}', { firstName: '  ' })).toBe('Hi there');
    expect(renderTemplate('Budget: {{fields.budget|n/a}}', { 'fields.budget': '10k' })).toBe(
      'Budget: 10k',
    );
  });

  it('fails permanently when a variable has neither value nor fallback', () => {
    expect(() => renderTemplate('Hi {{firstName}}', {})).toThrow(PermanentSendError);
  });
});

describe('templateVariables / templateParameters', () => {
  const body = 'Hi {{firstName|there}}, about {{company}}. Bye {{firstName}}!';

  it('lists variables once, in order of first appearance', () => {
    expect(templateVariables(body)).toEqual([
      { name: 'firstName', fallback: 'there' },
      { name: 'company', fallback: undefined },
    ]);
  });

  it('resolves parameter values in that order', () => {
    expect(templateParameters(body, { company: 'Acme' })).toEqual(['there', 'Acme']);
    expect(() => templateParameters(body, {})).toThrow(PermanentSendError);
  });
});

describe('leadTemplateVars', () => {
  it('exposes contact data and form answers', () => {
    const vars = leadTemplateVars({
      firstName: 'Ana',
      lastName: 'Souza',
      email: 'ana@acme.com',
      phone: null,
      company: 'Acme',
      source: 'website',
      score: 42,
      tier: 'warm',
      fields: { budget: 10000, interests: ['CRM', 'WhatsApp'], nested: { a: 1 } },
    });
    expect(vars).toEqual({
      firstName: 'Ana',
      lastName: 'Souza',
      fullName: 'Ana Souza',
      email: 'ana@acme.com',
      phone: undefined,
      company: 'Acme',
      source: 'website',
      score: '42',
      tier: 'warm',
      'fields.budget': '10000',
      'fields.interests': 'CRM, WhatsApp',
    });
  });
});
