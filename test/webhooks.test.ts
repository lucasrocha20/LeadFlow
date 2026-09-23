import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFormAdapters } from '../src/capture/adapters/index.js';
import { typeformSignature } from '../src/capture/adapters/typeform.js';
import type { CaptureLead } from '../src/capture/captureLead.js';
import { testAppDeps } from './helpers.js';

const formAdapters = createFormAdapters({
  DEFAULT_PHONE_COUNTRY: 'BR',
  FORM_WEBHOOK_SECRET: 'web-secret',
  TYPEFORM_WEBHOOK_SECRET: 'tf-secret',
});
const typeformBody = readFileSync(new URL('./fixtures/typeform.json', import.meta.url), 'utf8');

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

async function makeApp(captureLead: CaptureLead) {
  app = await buildApp(testAppDeps({ formAdapters, captureLead }));
  return app;
}

function fakeCapture() {
  return vi.fn<CaptureLead>(async () => ({
    leadId: 'lead-1',
    eventId: 'event-1',
    duplicate: false,
  }));
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /webhooks/forms/:provider', () => {
  it('captures a signed Typeform response', async () => {
    const capture = fakeCapture();
    const app = await makeApp(capture);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forms/typeform',
      headers: {
        'content-type': 'application/json',
        'typeform-signature': typeformSignature('tf-secret', typeformBody),
      },
      payload: typeformBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      leadId: 'lead-1',
      eventId: 'event-1',
      duplicate: false,
    });
    expect(capture).toHaveBeenCalledOnce();
    const [{ source, input, rawPayload }] = capture.mock.calls[0]!;
    expect(source).toBe('typeform');
    expect(input.email).toBe('maria.silva@acme.com');
    expect(rawPayload).toEqual(JSON.parse(typeformBody));
  });

  it('rejects a bad signature without capturing', async () => {
    const capture = fakeCapture();
    const app = await makeApp(capture);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forms/typeform',
      headers: { 'content-type': 'application/json', 'typeform-signature': 'sha256=forged' },
      payload: typeformBody,
    });

    expect(res.statusCode).toBe(401);
    expect(capture).not.toHaveBeenCalled();
  });

  it('captures a website submission with the shared secret', async () => {
    const capture = fakeCapture();
    const app = await makeApp(capture);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forms/website',
      headers: { 'x-webhook-secret': 'web-secret' },
      payload: { name: 'Ana Souza', email: 'ana@example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(capture.mock.calls[0]![0].source).toBe('website');
  });

  it('returns 404 for an unknown or disabled provider', async () => {
    const app = await makeApp(fakeCapture());
    for (const provider of ['hubspot-forms', 'toString', '__proto__']) {
      const res = await app.inject({
        method: 'POST',
        url: `/webhooks/forms/${provider}`,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('returns 400 for a malformed payload', async () => {
    const capture = fakeCapture();
    const app = await makeApp(capture);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forms/website',
      headers: { 'x-webhook-secret': 'web-secret' },
      payload: { email: 42 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(capture).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON', async () => {
    const app = await makeApp(fakeCapture());

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forms/website',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': 'web-secret' },
      payload: '{"email":',
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 500 when capturing fails, so the provider retries', async () => {
    const app = await makeApp(vi.fn<CaptureLead>().mockRejectedValue(new Error('redis down')));

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forms/website',
      headers: { 'x-webhook-secret': 'web-secret' },
      payload: { email: 'ana@example.com' },
    });

    expect(res.statusCode).toBe(500);
  });
});
