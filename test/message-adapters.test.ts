import { describe, expect, it, vi } from 'vitest';
import { dryRunAdapter } from '../src/contact/adapters/dryRun.js';
import { resendAdapter } from '../src/contact/adapters/resend.js';
import { PermanentSendError, type MessageTemplate } from '../src/contact/adapters/types.js';
import { whatsappAdapter } from '../src/contact/adapters/whatsapp.js';

const emailTemplate: MessageTemplate = {
  name: 'first_contact_email',
  channel: 'email',
  subject: 'Hi {{firstName|there}}',
  body: 'Hello {{firstName|there}} from {{company|your company}}',
  locale: null,
};
const whatsappTemplate: MessageTemplate = {
  name: 'first_contact_whatsapp',
  channel: 'whatsapp',
  subject: null,
  body: 'Hi {{firstName|there}}, about {{company|your company}}. Bye {{firstName}}',
  locale: 'pt_BR',
};
const vars = { firstName: 'Ana' };

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

function requestOf(fetchMock: ReturnType<typeof fakeFetch>) {
  const [url, init] = fetchMock.mock.calls[0]!;
  return {
    url,
    headers: init?.headers as Record<string, string>,
    body: JSON.parse(init?.body as string),
  };
}

describe('resendAdapter', () => {
  const send = (fetchMock: typeof fetch, template = emailTemplate) =>
    resendAdapter({ apiKey: 'key', from: 'Sales <s@acme.com>', fetch: fetchMock }).send({
      to: 'ana@example.com',
      template,
      vars,
      idempotencyKey: 'first-contact:lead-1:email',
    });

  it('sends the rendered email with an idempotency key', async () => {
    const fetchMock = fakeFetch(200, { id: 'email-123' });
    await expect(send(fetchMock)).resolves.toEqual({ externalId: 'email-123' });
    expect(requestOf(fetchMock)).toEqual({
      url: 'https://api.resend.com/emails',
      headers: {
        authorization: 'Bearer key',
        'content-type': 'application/json',
        'idempotency-key': 'first-contact:lead-1:email',
      },
      body: {
        from: 'Sales <s@acme.com>',
        to: ['ana@example.com'],
        subject: 'Hi Ana',
        text: 'Hello Ana from your company',
      },
    });
  });

  it('treats 429 and 5xx as retryable and other errors as permanent', async () => {
    for (const status of [429, 500, 503]) {
      const err = await send(fakeFetch(status, {})).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PermanentSendError);
    }
    for (const status of [400, 401, 422]) {
      await expect(send(fakeFetch(status, { message: 'bad' }))).rejects.toThrow(PermanentSendError);
    }
  });

  it('rejects a template without a subject', async () => {
    const fetchMock = fakeFetch(200, { id: 'x' });
    await expect(send(fetchMock, { ...emailTemplate, subject: null })).rejects.toThrow(
      PermanentSendError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('whatsappAdapter', () => {
  const send = (fetchMock: typeof fetch, template = whatsappTemplate) =>
    whatsappAdapter({ accessToken: 'token', phoneNumberId: '123', fetch: fetchMock }).send({
      to: '+5511987654321',
      template,
      vars,
      idempotencyKey: 'k',
    });

  it('sends an approved template with positional body parameters', async () => {
    const fetchMock = fakeFetch(200, { messages: [{ id: 'wamid.1' }] });
    await expect(send(fetchMock)).resolves.toEqual({ externalId: 'wamid.1' });
    const { url, headers, body } = requestOf(fetchMock);
    expect(url).toBe('https://graph.facebook.com/v23.0/123/messages');
    expect(headers.authorization).toBe('Bearer token');
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '5511987654321',
      type: 'template',
      template: {
        name: 'first_contact_whatsapp',
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ana' },
              { type: 'text', text: 'your company' },
            ],
          },
        ],
      },
    });
  });

  it('classifies errors like the other providers', async () => {
    await expect(send(fakeFetch(400, { error: { code: 131026 } }))).rejects.toThrow(
      PermanentSendError,
    );
    const err = await send(fakeFetch(503, {})).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PermanentSendError);
  });

  it('requires a locale', async () => {
    await expect(send(fakeFetch(200, {}), { ...whatsappTemplate, locale: null })).rejects.toThrow(
      PermanentSendError,
    );
  });
});

describe('dryRunAdapter', () => {
  it('logs the rendered message and returns a fake id', async () => {
    const log = { info: vi.fn() };
    const { externalId } = await dryRunAdapter(log).send({
      to: 'ana@example.com',
      template: emailTemplate,
      vars,
      idempotencyKey: 'k',
    });
    expect(externalId).toMatch(/^dry-run-/);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ana@example.com',
        subject: 'Hi Ana',
        body: 'Hello Ana from your company',
      }),
      'dry-run message',
    );
  });
});
