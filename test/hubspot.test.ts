import { describe, expect, it, vi } from 'vitest';
import { hubspotAdapter } from '../src/crm/adapters/hubspot.js';
import { createRateLimiter } from '../src/crm/rateLimiter.js';
import { CrmNotFoundError, CrmPermanentError, CrmRateLimitError } from '../src/crm/types.js';

function fakeFetch(...responses: [number, unknown, Record<string, string>?][]) {
  const queue = [...responses];
  return vi.fn<typeof fetch>(async () => {
    const [status, body, headers] = queue.shift() ?? [200, {}];
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  });
}

function requests(fetchMock: ReturnType<typeof fakeFetch>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    method: init?.method,
    url: String(url).replace('https://api.hubapi.com', ''),
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
}

const contact = {
  email: 'ana@acme.com',
  phone: '+5511987654321',
  firstName: 'Ana',
  lastName: null,
  company: 'Acme',
};

describe('hubspotAdapter', () => {
  it('upserts by email when the contact id is unknown, sending only known fields', async () => {
    const fetchMock = fakeFetch([200, { results: [{ id: '101' }] }]);
    const crm = hubspotAdapter({ accessToken: 'tok', fetch: fetchMock });

    expect(await crm.upsertContact(contact, null)).toBe('101');
    expect(requests(fetchMock)).toEqual([
      {
        method: 'POST',
        url: '/crm/v3/objects/contacts/batch/upsert',
        body: {
          inputs: [
            {
              idProperty: 'email',
              id: 'ana@acme.com',
              properties: {
                email: 'ana@acme.com',
                phone: '+5511987654321',
                firstname: 'Ana',
                company: 'Acme',
              },
            },
          ],
        },
      },
    ]);
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe(
      'Bearer tok',
    );
  });

  it('updates by id once known, and creates phone-only contacts', async () => {
    const fetchMock = fakeFetch([200, { id: '101' }], [201, { id: '202' }]);
    const crm = hubspotAdapter({ accessToken: 'tok', fetch: fetchMock });

    expect(await crm.upsertContact(contact, '101')).toBe('101');
    expect(await crm.upsertContact({ ...contact, email: null }, null)).toBe('202');
    expect(requests(fetchMock).map((r) => [r.method, r.url])).toEqual([
      ['PATCH', '/crm/v3/objects/contacts/101'],
      ['POST', '/crm/v3/objects/contacts'],
    ]);
  });

  it('sets stage properties and the owner on the contact', async () => {
    const fetchMock = fakeFetch([200, {}], [200, {}]);
    const crm = hubspotAdapter({ accessToken: 'tok', fetch: fetchMock });

    await crm.updateStage('101', { hs_lead_status: 'CONNECTED' });
    await crm.updateStage('101', {}); // nothing to set: no request
    await crm.assignOwner('101', '777');
    expect(requests(fetchMock)).toEqual([
      {
        method: 'PATCH',
        url: '/crm/v3/objects/contacts/101',
        body: { properties: { hs_lead_status: 'CONNECTED' } },
      },
      {
        method: 'PATCH',
        url: '/crm/v3/objects/contacts/101',
        body: { properties: { hubspot_owner_id: '777' } },
      },
    ]);
  });

  it('logs activities as notes associated with the contact, with escaped HTML', async () => {
    const fetchMock = fakeFetch([201, { id: 'note-1' }]);
    const crm = hubspotAdapter({ accessToken: 'tok', fetch: fetchMock });

    await crm.logActivity('101', {
      title: 'LeadFlow: Reply received on Email',
      body: 'Hi <team> & co\nCall me',
      occurredAt: new Date('2026-09-23T15:00:00Z'),
    });
    expect(requests(fetchMock)).toEqual([
      {
        method: 'POST',
        url: '/crm/v3/objects/notes',
        body: {
          properties: {
            hs_timestamp: '2026-09-23T15:00:00.000Z',
            hs_note_body:
              '<strong>LeadFlow: Reply received on Email</strong><br>Hi &lt;team&gt; &amp; co<br>Call me',
          },
          associations: [
            {
              to: { id: '101' },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
            },
          ],
        },
      },
    ]);
  });

  it('permanently deletes a contact, treating an already deleted one as done', async () => {
    const fetchMock = fakeFetch([204, null], [404, { message: 'not found' }], [403, {}]);
    const crm = hubspotAdapter({ accessToken: 'tok', fetch: fetchMock });

    await crm.deleteContact('101');
    await crm.deleteContact('102');
    await expect(crm.deleteContact('103')).rejects.toBeInstanceOf(CrmPermanentError);
    expect(requests(fetchMock).slice(0, 2)).toEqual([
      { method: 'POST', url: '/crm/v3/objects/contacts/gdpr-delete', body: { objectId: '101' } },
      { method: 'POST', url: '/crm/v3/objects/contacts/gdpr-delete', body: { objectId: '102' } },
    ]);
  });

  it('classifies errors: 429 rate limit, 404 not found, 5xx retryable, other 4xx permanent', async () => {
    const call = (status: number, headers?: Record<string, string>) =>
      hubspotAdapter({ accessToken: 'tok', fetch: fakeFetch([status, { message: 'x' }, headers]) })
        .assignOwner('101', '1')
        .catch((e: unknown) => e);

    const limited = await call(429, { 'retry-after': '3' });
    expect(limited).toBeInstanceOf(CrmRateLimitError);
    expect((limited as CrmRateLimitError).retryAfterMs).toBe(3000);
    expect(((await call(429)) as CrmRateLimitError).retryAfterMs).toBe(10_000);
    expect(await call(404)).toBeInstanceOf(CrmNotFoundError);
    const serverError = await call(502);
    expect(serverError).toBeInstanceOf(Error);
    expect(serverError).not.toBeInstanceOf(CrmPermanentError);
    expect(await call(400)).toBeInstanceOf(CrmPermanentError);
    expect(await call(403)).toBeInstanceOf(CrmPermanentError);
  });
});

describe('createRateLimiter', () => {
  it('lets `max` calls through per window, then waits', async () => {
    const acquire = createRateLimiter(2, 150);
    const started = Date.now();
    await acquire();
    await acquire();
    expect(Date.now() - started).toBeLessThan(50);
    await acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});
