import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { hubspotSignature, hubspotWebhook, type CrmWebhook } from '../src/crm/webhook.js';
import type { Db } from '../src/db.js';
import { testAppDeps } from './helpers.js';

const secret = 'client-secret';
const url = 'https://leads.example.com/webhooks/crm/hubspot';
const now = 1_790_000_000_000;
const webhook = hubspotWebhook({ db: {} as Db, secret, config: { inbound: [] }, now: () => now });

function signed(body: string, timestamp = String(now)) {
  return {
    'x-hubspot-signature-v3': hubspotSignature(
      secret,
      { method: 'POST', url, rawBody: body },
      timestamp,
    ),
    'x-hubspot-request-timestamp': timestamp,
  };
}

describe('hubspotWebhook', () => {
  const body = '[{"eventId":1}]';
  const req = (headers: Record<string, string>) => ({
    method: 'POST',
    url,
    headers,
    rawBody: Buffer.from(body),
  });

  it('accepts a fresh, correctly signed request', () => {
    expect(webhook.verify(req(signed(body)))).toBe(true);
  });

  it('rejects a wrong signature, another URL, or a timestamp older than 5 minutes', () => {
    expect(webhook.verify(req({ ...signed(body), 'x-hubspot-signature-v3': 'forged' }))).toBe(
      false,
    );
    expect(webhook.verify({ ...req(signed(body)), url: 'https://evil.example.com/x' })).toBe(false);
    expect(webhook.verify(req(signed(body, String(now - 6 * 60_000))))).toBe(false);
    expect(webhook.verify(req({}))).toBe(false);
  });

  it('keeps only contact property changes', () => {
    expect(
      webhook.parse([
        {
          eventId: 1,
          subscriptionType: 'contact.propertyChange',
          objectId: 101,
          propertyName: 'lifecyclestage',
          propertyValue: 'customer',
        },
        { eventId: 2, subscriptionType: 'contact.creation', objectId: 102 },
        {
          eventId: 3,
          subscriptionType: 'deal.propertyChange',
          objectId: 9,
          propertyName: 'dealstage',
          propertyValue: 'won',
        },
      ]),
    ).toEqual([{ eventId: '1', crmId: '101', property: 'lifecyclestage', value: 'customer' }]);
    expect(() => webhook.parse({ not: 'an array' })).toThrow();
  });
});

describe('POST /webhooks/crm/hubspot', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('verifies against the public URL and hands changes to the handler', async () => {
    const handle = vi.fn<CrmWebhook['handle']>(async () => ({ status: 'unmatched' }));
    const real = hubspotWebhook({ db: {} as Db, secret, config: { inbound: [] } });
    app = await buildApp(
      testAppDeps({
        crmWebhook: { webhook: { ...real, handle }, publicBaseUrl: 'https://leads.example.com' },
      }),
    );
    const body = JSON.stringify([
      {
        eventId: 7,
        subscriptionType: 'contact.propertyChange',
        objectId: 101,
        propertyName: 'lifecyclestage',
        propertyValue: 'customer',
      },
    ]);
    const post = (headers: Record<string, string>) =>
      app!.inject({
        method: 'POST',
        url: '/webhooks/crm/hubspot',
        headers: { 'content-type': 'application/json', ...headers },
        payload: body,
      });

    const timestamp = String(Date.now());
    const ok = await post({
      'x-hubspot-signature-v3': hubspotSignature(
        secret,
        { method: 'POST', url, rawBody: body },
        timestamp,
      ),
      'x-hubspot-request-timestamp': timestamp,
    });
    expect(ok.statusCode).toBe(200);
    expect(handle).toHaveBeenCalledWith({
      eventId: '7',
      crmId: '101',
      property: 'lifecyclestage',
      value: 'customer',
    });

    expect(
      (await post({ 'x-hubspot-signature-v3': 'x', 'x-hubspot-request-timestamp': timestamp }))
        .statusCode,
    ).toBe(401);
  });

  it('is not served unless configured', async () => {
    app = await buildApp(testAppDeps());
    expect(
      (await app.inject({ method: 'POST', url: '/webhooks/crm/hubspot', payload: [] })).statusCode,
    ).toBe(404);
  });
});
