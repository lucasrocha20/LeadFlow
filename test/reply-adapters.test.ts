import { describe, expect, it } from 'vitest';
import { emailReplyAdapter } from '../src/inbound/adapters/email.js';
import { createReplyAdapters } from '../src/inbound/adapters/index.js';
import { whatsappReplyAdapter, whatsappSignature } from '../src/inbound/adapters/whatsapp.js';

function whatsappPayload(messages: unknown[], statuses: unknown[] = []) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '123' },
              contacts: [{ wa_id: '5511987654321', profile: { name: 'Maria' } }],
              messages,
              statuses,
            },
          },
        ],
      },
    ],
  };
}

describe('whatsappReplyAdapter', () => {
  const adapter = whatsappReplyAdapter({ appSecret: 'app-secret' });

  it('verifies the X-Hub-Signature-256 HMAC over the raw body', () => {
    const rawBody = Buffer.from(JSON.stringify(whatsappPayload([])));
    const signature = whatsappSignature('app-secret', rawBody);
    expect(adapter.verify({ headers: { 'x-hub-signature-256': signature }, rawBody })).toBe(true);
    expect(
      adapter.verify({
        headers: { 'x-hub-signature-256': whatsappSignature('other', rawBody) },
        rawBody,
      }),
    ).toBe(false);
    expect(adapter.verify({ headers: {}, rawBody })).toBe(false);
  });

  it('parses text, button and interactive replies, and media with empty text', () => {
    const base = { from: '5511987654321', timestamp: '1790186400' };
    const messages = adapter.parse(
      whatsappPayload([
        { ...base, id: 'wamid.1', type: 'text', text: { body: 'Yes, call me' } },
        { ...base, id: 'wamid.2', type: 'button', button: { text: 'Stop promotions' } },
        {
          ...base,
          id: 'wamid.3',
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Talk now' } },
        },
        { ...base, id: 'wamid.4', type: 'image', image: { id: 'media-1' } },
      ]),
    );
    expect(messages).toEqual([
      {
        channel: 'whatsapp',
        externalId: 'wamid.1',
        from: '+5511987654321',
        text: 'Yes, call me',
        receivedAt: new Date(1790186400 * 1000),
      },
      expect.objectContaining({ externalId: 'wamid.2', text: 'Stop promotions' }),
      expect.objectContaining({ externalId: 'wamid.3', text: 'Talk now' }),
      expect.objectContaining({ externalId: 'wamid.4', text: '' }),
    ]);
  });

  it('ignores delivery status updates', () => {
    expect(adapter.parse(whatsappPayload([], [{ id: 'wamid.x', status: 'delivered' }]))).toEqual(
      [],
    );
  });

  it('rejects payloads that are not WhatsApp webhooks', () => {
    expect(() => adapter.parse({ object: 'page', entry: [] })).toThrow();
  });
});

describe('emailReplyAdapter', () => {
  const adapter = emailReplyAdapter({ secret: 'reply-secret' });

  it('checks the shared secret header', () => {
    const rawBody = Buffer.from('{}');
    expect(adapter.verify({ headers: { 'x-webhook-secret': 'reply-secret' }, rawBody })).toBe(true);
    expect(adapter.verify({ headers: { 'x-webhook-secret': 'nope' }, rawBody })).toBe(false);
  });

  it('extracts and normalizes the sender address', () => {
    expect(
      adapter.parse({
        from: 'Ana Souza <Ana.Souza@Acme.com>',
        subject: 'Re: Following up',
        text: 'Sure, Tuesday works',
        messageId: '<abc@mail.acme.com>',
      }),
    ).toEqual([
      {
        channel: 'email',
        externalId: '<abc@mail.acme.com>',
        from: 'ana.souza@acme.com',
        text: 'Sure, Tuesday works',
        subject: 'Re: Following up',
        receivedAt: expect.any(Date),
      },
    ]);
  });

  it('falls back to a payload hash for the id and skips unusable senders', () => {
    const [message] = adapter.parse({ from: 'ana@acme.com', text: 'hi' });
    expect(message!.externalId).toMatch(/^[0-9a-f]{64}$/);
    expect(adapter.parse({ from: 'not an address' })).toEqual([]);
    expect(() => adapter.parse({ text: 'no sender' })).toThrow();
  });
});

describe('createReplyAdapters', () => {
  it('only enables providers whose secret is set', () => {
    expect(
      Object.keys(
        createReplyAdapters({ WHATSAPP_APP_SECRET: 'x', REPLY_WEBHOOK_SECRET: undefined }),
      ),
    ).toEqual(['whatsapp']);
  });
});
