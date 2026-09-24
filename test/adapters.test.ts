import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFormAdapters } from '../src/capture/adapters/index.js';
import { typeformAdapter, typeformSignature } from '../src/capture/adapters/typeform.js';
import { websiteFormAdapter } from '../src/capture/adapters/website.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe('typeformAdapter', () => {
  const adapter = typeformAdapter({ secret: 'tf-secret', defaultCountry: 'BR' });
  const rawBody = fixture('typeform.json');

  it('accepts a valid signature and rejects anything else', () => {
    const signature = typeformSignature('tf-secret', rawBody);
    expect(adapter.verify({ headers: { 'typeform-signature': signature }, rawBody })).toBe(true);
    expect(
      adapter.verify({
        headers: { 'typeform-signature': typeformSignature('wrong', rawBody) },
        rawBody,
      }),
    ).toBe(false);
    expect(
      adapter.verify({
        headers: { 'typeform-signature': signature },
        rawBody: Buffer.concat([rawBody, Buffer.from(' ')]),
      }),
    ).toBe(false);
    expect(adapter.verify({ headers: {}, rawBody })).toBe(false);
  });

  it('normalizes a form response', () => {
    expect(adapter.normalize(JSON.parse(rawBody.toString()))).toEqual({
      externalId: 'a3a12ec67a1365927098a606107fac15',
      firstName: 'Maria',
      lastName: 'da Silva',
      email: 'maria.silva@acme.com',
      phone: '+5511987654321',
      company: 'Acme Ltda',
      timezone: null,
      utm: { source: 'google', medium: 'cpc', campaign: 'spring-launch' },
      fields: {
        company_size: '50-200',
        budget: 20000,
        interests: ['CRM sync', 'WhatsApp'],
        page: '/pricing',
      },
      consentEmail: true,
      consentMessaging: true,
      consentEvidence: {
        formId: 'lT4Z3j',
        responseToken: 'a3a12ec67a1365927098a606107fac15',
        submittedAt: '2026-09-23T12:00:00Z',
        questions: [
          {
            ref: 'consent',
            title: 'I agree to be contacted by email and WhatsApp about this request.',
          },
        ],
      },
    });
  });

  it('rejects payloads that are not form responses', () => {
    expect(() => adapter.normalize({ event_type: 'something_else' })).toThrow();
    expect(() => adapter.normalize({ event_type: 'form_response', form_response: {} })).toThrow();
  });
});

describe('websiteFormAdapter', () => {
  const adapter = websiteFormAdapter({ secret: 'web-secret', defaultCountry: 'BR' });
  const payload = JSON.parse(fixture('website.json').toString());

  it('checks the shared secret header', () => {
    const rawBody = Buffer.from('{}');
    expect(adapter.verify({ headers: { 'x-webhook-secret': 'web-secret' }, rawBody })).toBe(true);
    expect(adapter.verify({ headers: { 'x-webhook-secret': 'nope' }, rawBody })).toBe(false);
    expect(adapter.verify({ headers: {}, rawBody })).toBe(false);
  });

  it('normalizes a submission', () => {
    expect(adapter.normalize(payload)).toEqual({
      externalId: 'sub_123',
      firstName: 'João',
      lastName: 'Pereira',
      email: 'joao@example.com',
      phone: '+5521998765432',
      company: 'Pereira & Filhos',
      timezone: 'America/Sao_Paulo',
      utm: { source: 'newsletter', campaign: 'sept' },
      fields: { message: 'Quero uma demo', budget: '5k-10k' },
      consentEmail: true,
      consentMessaging: false,
      consentEvidence: { submissionId: 'sub_123', receivedAt: expect.any(String) },
    });
  });

  it('keeps the consent evidence the website sends', () => {
    const consent = {
      text: 'I agree to receive emails about my request.',
      version: 'v3',
      at: '2026-09-23T12:00:00-03:00',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      pageUrl: 'https://acme.com/contact',
    };
    expect(adapter.normalize({ ...payload, consent }).consentEvidence).toEqual({
      submissionId: 'sub_123',
      ...consent,
      receivedAt: expect.any(String),
    });
    expect(() => adapter.normalize({ ...payload, consent: { at: 'yesterday' } })).toThrow();
  });

  it('derives a stable external id from the payload when submissionId is missing', () => {
    const withoutId = { ...payload, submissionId: undefined };
    const a = adapter.normalize(withoutId).externalId;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(adapter.normalize({ ...withoutId }).externalId).toBe(a);
    expect(adapter.normalize({ ...withoutId, email: 'other@example.com' }).externalId).not.toBe(a);
  });

  it('rejects malformed payloads', () => {
    expect(() => adapter.normalize({ email: 42 })).toThrow();
    expect(() => adapter.normalize('hello')).toThrow();
  });
});

describe('createFormAdapters', () => {
  it('only enables providers whose secret is set', () => {
    const adapters = createFormAdapters({
      DEFAULT_PHONE_COUNTRY: 'BR',
      FORM_WEBHOOK_SECRET: 'x',
      TYPEFORM_WEBHOOK_SECRET: undefined,
    });
    expect(Object.keys(adapters)).toEqual(['website']);
  });
});
