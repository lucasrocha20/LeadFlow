import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createReplyAdapters } from '../src/inbound/adapters/index.js';
import { whatsappSignature } from '../src/inbound/adapters/whatsapp.js';
import type { HandleInbound } from '../src/inbound/handleInbound.js';
import { unsubscribeToken, verifyUnsubscribeToken } from '../src/inbound/unsubscribe.js';
import { testAppDeps } from './helpers.js';

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const replyAdapters = createReplyAdapters({
  WHATSAPP_APP_SECRET: 'app-secret',
  REPLY_WEBHOOK_SECRET: 'reply-secret',
});

describe('GET /webhooks/replies/whatsapp (Meta verification)', () => {
  const verify = (query: string) =>
    app!.inject({ method: 'GET', url: `/webhooks/replies/whatsapp?${query}` });

  it('echoes the challenge when the verify token matches', async () => {
    app = await buildApp(testAppDeps({ whatsappVerifyToken: 'verify-me' }));
    const res = await verify('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('12345');
  });

  it('refuses a wrong or unconfigured token', async () => {
    app = await buildApp(testAppDeps({ whatsappVerifyToken: 'verify-me' }));
    expect(
      (await verify('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).statusCode,
    ).toBe(403);
    await app.close();
    app = await buildApp(testAppDeps());
    expect((await verify('hub.mode=subscribe&hub.verify_token=&hub.challenge=1')).statusCode).toBe(
      403,
    );
  });
});

describe('POST /webhooks/replies/:provider', () => {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: '5511987654321',
                  id: 'wamid.1',
                  timestamp: '1790186400',
                  type: 'text',
                  text: { body: 'hi' },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  function makeApp() {
    const handleInbound = vi.fn<HandleInbound>(async () => ({ status: 'unmatched' }));
    return { handleInbound, promise: buildApp(testAppDeps({ replyAdapters, handleInbound })) };
  }

  it('hands each signed message to the inbound handler', async () => {
    const { handleInbound, promise } = makeApp();
    app = await promise;
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/replies/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': whatsappSignature('app-secret', body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', results: [{ status: 'unmatched' }] });
    expect(handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', from: '+5511987654321', text: 'hi' }),
    );
  });

  it('rejects bad signatures, unknown providers and malformed payloads', async () => {
    const { handleInbound, promise } = makeApp();
    app = await promise;
    const post = (url: string, headers: Record<string, string>, payload: string) =>
      app!.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json', ...headers },
        payload,
      });

    expect(
      (await post('/webhooks/replies/whatsapp', { 'x-hub-signature-256': 'sha256=forged' }, body))
        .statusCode,
    ).toBe(401);
    expect((await post('/webhooks/replies/sms', {}, body)).statusCode).toBe(404);
    expect(
      (
        await post(
          '/webhooks/replies/email',
          { 'x-webhook-secret': 'reply-secret' },
          '{"text":"no from"}',
        )
      ).statusCode,
    ).toBe(400);
    expect(handleInbound).not.toHaveBeenCalled();
  });
});

describe('/unsubscribe', () => {
  const secret = 'unsub-secret';
  const token = unsubscribeToken(secret, 'lead-1');

  async function makeApp() {
    const optOut = vi.fn(async () => true);
    app = await buildApp(
      testAppDeps({
        unsubscribe: { verify: (lead, t) => verifyUnsubscribeToken(secret, lead, t), optOut },
      }),
    );
    return optOut;
  }

  it('GET only shows a confirmation form', async () => {
    const optOut = await makeApp();
    const res = await app!.inject({
      method: 'GET',
      url: `/unsubscribe?lead=lead-1&token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<form method="post">');
    expect(optOut).not.toHaveBeenCalled();
  });

  it('POST unsubscribes, including one-click requests from mail clients', async () => {
    const optOut = await makeApp();
    const res = await app!.inject({
      method: 'POST',
      url: `/unsubscribe?lead=lead-1&token=${token}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Unsubscribed');
    expect(optOut).toHaveBeenCalledWith('lead-1');
  });

  it('rejects a forged token', async () => {
    const optOut = await makeApp();
    for (const method of ['GET', 'POST'] as const) {
      const res = await app!.inject({ method, url: `/unsubscribe?lead=lead-2&token=${token}` });
      expect(res.statusCode).toBe(400);
    }
    expect(optOut).not.toHaveBeenCalled();
  });

  it('is not served when unsubscribe links are not configured', async () => {
    app = await buildApp(testAppDeps());
    const res = await app.inject({ method: 'GET', url: `/unsubscribe?lead=lead-1&token=${token}` });
    expect(res.statusCode).toBe(404);
  });
});
