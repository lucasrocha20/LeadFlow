import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { presentedToken } from '../src/admin/auth.js';
import { InvalidSubjectError } from '../src/admin/service.js';
import { buildApp } from '../src/app.js';
import { fakeAdminService, testAppDeps } from './helpers.js';

const token = 'a'.repeat(32);
const bearer = { authorization: `Bearer ${token}` };

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

async function makeApp(service = fakeAdminService()) {
  app = await buildApp(testAppDeps({ admin: { token, service } }));
  return { app, service };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('presentedToken', () => {
  it.each([
    [undefined, null],
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['Bearer ', null],
    [`Basic ${Buffer.from('ops:s3cret:with:colons').toString('base64')}`, 's3cret:with:colons'],
    [`Basic ${Buffer.from('no-colon').toString('base64')}`, null],
    ['Token abc', null],
  ])('%s → %s', (header, expected) => {
    expect(presentedToken(header)).toBe(expected);
  });
});

describe('admin auth', () => {
  it('is not served when admin is not configured', async () => {
    app = await buildApp(testAppDeps());
    const res = await app.inject({ method: 'GET', url: '/admin/api/queues', headers: bearer });
    expect(res.statusCode).toBe(404);
  });

  it.each([
    ['no credentials', {}],
    ['a wrong bearer token', { authorization: 'Bearer wrong' }],
    ['a token with a different length', { authorization: `Bearer ${token}x` }],
    ['a wrong Basic password', { authorization: `Basic ${btoa('ops:wrong')}` }],
  ])('rejects %s with a Basic challenge', async (_, headers) => {
    const { app, service } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/api/queues', headers });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Basic realm="LeadFlow admin"/);
    expect(service.queueStats).not.toHaveBeenCalled();
  });

  it.each([
    ['a bearer token', bearer],
    ['Basic auth with any username', { authorization: `Basic ${btoa(`ops:${token}`)}` }],
  ])('accepts %s', async (_, headers) => {
    const { app, service } = await makeApp();
    service.queueStats.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/admin/api/queues', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ queues: [] });
  });
});

describe('GET /admin/api/leads', () => {
  it('parses filters', async () => {
    const { app, service } = await makeApp();
    service.listLeads.mockResolvedValue({ leads: [], nextCursor: null });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/leads',
      query: {
        status: 'contacted, engaged',
        tier: 'hot',
        source: 'typeform',
        q: 'ana',
        createdFrom: '2026-09-01',
        crmSyncFailed: 'true',
        limit: '10',
      },
      headers: bearer,
    });
    expect(res.statusCode).toBe(200);
    expect(service.listLeads).toHaveBeenCalledWith({
      status: ['contacted', 'engaged'],
      tier: ['hot'],
      source: 'typeform',
      q: 'ana',
      createdFrom: new Date('2026-09-01'),
      crmSyncFailed: true,
      limit: 10,
    });
  });

  it('defaults the page size', async () => {
    const { app, service } = await makeApp();
    service.listLeads.mockResolvedValue({ leads: [], nextCursor: null });
    await app.inject({ method: 'GET', url: '/admin/api/leads', headers: bearer });
    expect(service.listLeads).toHaveBeenCalledWith({ limit: 50 });
  });

  it.each([
    ['an unknown status', { status: 'contacted,bogus' }],
    ['a limit over 200', { limit: '500' }],
    ['a bad date', { createdFrom: 'yesterday' }],
    ['a non-boolean flag', { crmSyncFailed: 'yes' }],
  ])('rejects %s', async (_, query) => {
    const { app, service } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/leads',
      query,
      headers: bearer,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
    expect(service.listLeads).not.toHaveBeenCalled();
  });
});

describe('GET /admin/api/leads/:id', () => {
  it('returns 404 for an unknown lead and 400 for a malformed id', async () => {
    const { app, service } = await makeApp();
    service.getLead.mockResolvedValue(null);
    const missing = await app.inject({
      method: 'GET',
      url: `/admin/api/leads/${randomUUID()}`,
      headers: bearer,
    });
    expect(missing.statusCode).toBe(404);
    const malformed = await app.inject({
      method: 'GET',
      url: '/admin/api/leads/not-a-uuid',
      headers: bearer,
    });
    expect(malformed.statusCode).toBe(400);
  });
});

describe('enrollment pause/resume', () => {
  const id = randomUUID();

  it('pauses with a reason', async () => {
    const { app, service } = await makeApp();
    service.pauseEnrollment.mockResolvedValue({ status: 'paused', enrollmentId: id, leadId: 'l' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/enrollments/${id}/pause`,
      payload: { reason: 'on a call' },
      headers: bearer,
    });
    expect(res.statusCode).toBe(200);
    expect(service.pauseEnrollment).toHaveBeenCalledWith(id, 'on a call');
  });

  it('pauses without a body', async () => {
    const { app, service } = await makeApp();
    service.pauseEnrollment.mockResolvedValue({ status: 'paused', enrollmentId: id, leadId: 'l' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/enrollments/${id}/pause`,
      headers: bearer,
    });
    expect(res.statusCode).toBe(200);
    expect(service.pauseEnrollment).toHaveBeenCalledWith(id, undefined);
  });

  it('returns 409 with the current status on a conflict', async () => {
    const { app, service } = await makeApp();
    service.resumeEnrollment.mockResolvedValue({ status: 'conflict', current: 'stopped' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/enrollments/${id}/resume`,
      headers: bearer,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'invalid_state', current: 'stopped' });
  });

  it('returns 404 for an unknown enrollment', async () => {
    const { app, service } = await makeApp();
    service.resumeEnrollment.mockResolvedValue({ status: 'not_found' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/enrollments/${id}/resume`,
      headers: bearer,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('queue repair', () => {
  it('retries failed jobs of a queue', async () => {
    const { app, service } = await makeApp();
    service.retryFailed.mockResolvedValue(3);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/queues/message.send/retry-failed',
      headers: bearer,
    });
    expect(res.json()).toEqual({ queue: 'message.send', retried: 3 });
  });

  it('returns 404 for an unknown queue', async () => {
    const { app, service } = await makeApp();
    service.retryFailed.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/queues/nope/retry-failed',
      headers: bearer,
    });
    expect(res.statusCode).toBe(404);
  });

  it('requeues all CRM dead letters, or specific leads', async () => {
    const { app, service } = await makeApp();
    service.requeueCrmDeadLetters.mockResolvedValue(2);
    const all = await app.inject({
      method: 'POST',
      url: '/admin/api/crm/requeue',
      headers: bearer,
    });
    expect(all.json()).toEqual({ requeued: 2 });
    expect(service.requeueCrmDeadLetters).toHaveBeenLastCalledWith(undefined);

    const leadId = randomUUID();
    await app.inject({
      method: 'POST',
      url: '/admin/api/crm/requeue',
      payload: { leadIds: [leadId] },
      headers: bearer,
    });
    expect(service.requeueCrmDeadLetters).toHaveBeenLastCalledWith([leadId]);

    const bad = await app.inject({
      method: 'POST',
      url: '/admin/api/crm/requeue',
      payload: { leadIds: ['x'] },
      headers: bearer,
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('GET /admin/api/metrics', () => {
  it('defaults to the last 30 days', async () => {
    const { app, service } = await makeApp();
    service.metrics.mockResolvedValue({} as never);
    const before = Date.now();
    await app.inject({ method: 'GET', url: '/admin/api/metrics', headers: bearer });
    const range = service.metrics.mock.calls[0]![0];
    expect(range.to.getTime()).toBeGreaterThanOrEqual(before);
    expect(range.to.getTime() - range.from.getTime()).toBe(30 * 24 * 60 * 60_000);
    expect(range.source).toBeUndefined();
  });

  it.each([
    ['from after to', { from: '2026-09-10', to: '2026-09-01' }],
    ['a range over 366 days', { from: '2024-01-01', to: '2026-01-01' }],
  ])('rejects %s', async (_, query) => {
    const { app, service } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/metrics',
      query,
      headers: bearer,
    });
    expect(res.statusCode).toBe(400);
    expect(service.metrics).not.toHaveBeenCalled();
  });
});

describe('privacy requests', () => {
  const erased = { erased: 1, crmDeleted: 0, suppressed: 2 };

  it('exports by email and/or phone', async () => {
    const { app, service } = await makeApp();
    service.exportSubject.mockResolvedValue({
      generatedAt: new Date(),
      subject: {},
      suppressed: false,
      leads: [],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/privacy/export',
      payload: { email: 'Ana@Acme.com' },
      headers: bearer,
    });
    expect(res.statusCode).toBe(200);
    expect(service.exportSubject).toHaveBeenCalledWith({ email: 'Ana@Acme.com' });

    const empty = await app.inject({
      method: 'POST',
      url: '/admin/api/privacy/export',
      payload: {},
      headers: bearer,
    });
    expect(empty.statusCode).toBe(400);
  });

  it('erases only with explicit confirmation', async () => {
    const { app, service } = await makeApp();
    service.eraseSubject.mockResolvedValue(erased);
    const unconfirmed = await app.inject({
      method: 'POST',
      url: '/admin/api/privacy/erase',
      payload: { email: 'ana@acme.com' },
      headers: bearer,
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(service.eraseSubject).not.toHaveBeenCalled();

    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/privacy/erase',
      payload: { email: 'ana@acme.com', confirm: true },
      headers: bearer,
    });
    expect(res.json()).toEqual(erased);
    expect(service.eraseSubject).toHaveBeenCalledWith({
      subject: { email: 'ana@acme.com', phone: undefined },
      leadIds: undefined,
      deleteFromCrm: false,
    });
  });

  it('erases by lead id, optionally from the CRM too', async () => {
    const { app, service } = await makeApp();
    service.eraseSubject.mockResolvedValue(erased);
    const leadId = randomUUID();
    await app.inject({
      method: 'POST',
      url: '/admin/api/privacy/erase',
      payload: { leadIds: [leadId], deleteFromCrm: true, confirm: true },
      headers: bearer,
    });
    expect(service.eraseSubject).toHaveBeenCalledWith({
      subject: undefined,
      leadIds: [leadId],
      deleteFromCrm: true,
    });

    const nothing = await app.inject({
      method: 'POST',
      url: '/admin/api/privacy/erase',
      payload: { confirm: true },
      headers: bearer,
    });
    expect(nothing.statusCode).toBe(400);
  });

  it('rejects an address that cannot be normalized', async () => {
    const { app, service } = await makeApp();
    service.eraseSubject.mockRejectedValue(new InvalidSubjectError('Invalid phone'));
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/privacy/erase',
      payload: { phone: 'abc', confirm: true },
      headers: bearer,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_subject', message: 'Invalid phone' });
  });
});
