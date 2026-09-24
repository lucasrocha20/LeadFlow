import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { testAppDeps } from './helpers.js';

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

async function makeApp(overrides: Partial<AppDeps>) {
  app = await buildApp(testAppDeps({ readinessChecks: { ok: async () => {} }, ...overrides }));
  // A route that reports the client IP Fastify resolved.
  app.get('/ip', async (request) => ({ ip: request.ip }));
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const base = testAppDeps().config;

describe('rate limiting', () => {
  it('limits each client IP, but never health checks', async () => {
    const app = await makeApp({ rateLimit: { perMinute: 2 } });
    const get = (url: string, remoteAddress = '198.51.100.1') =>
      app.inject({ method: 'GET', url, remoteAddress });

    expect((await get('/ip')).statusCode).toBe(200);
    expect((await get('/ip')).statusCode).toBe(200);
    const limited = await get('/ip');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();

    expect((await get('/ip', '198.51.100.2')).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await get('/health')).statusCode).toBe(200);
      expect((await get('/health/ready')).statusCode).toBe(200);
    }
  });

  it('is off when set to 0', async () => {
    const app = await makeApp({ rateLimit: { perMinute: 0 } });
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/ip' })).statusCode).toBe(200);
    }
  });

  it('ignores X-Forwarded-For unless the proxy is trusted', async () => {
    const untrusted = await makeApp({ rateLimit: { perMinute: 1 } });
    const spoof = (ip: string) =>
      untrusted.inject({ method: 'GET', url: '/ip', headers: { 'x-forwarded-for': ip } });
    expect((await spoof('203.0.113.1')).statusCode).toBe(200);
    // A client can't dodge the limit by making up a forwarded address.
    expect((await spoof('203.0.113.2')).statusCode).toBe(429);
    await untrusted.close();

    const trusted = await makeApp({
      config: { ...base, TRUST_PROXY: true },
      rateLimit: { perMinute: 1 },
    });
    const viaProxy = (ip: string) =>
      trusted.inject({ method: 'GET', url: '/ip', headers: { 'x-forwarded-for': ip } });
    expect((await viaProxy('203.0.113.1')).statusCode).toBe(200);
    expect((await viaProxy('203.0.113.2')).statusCode).toBe(200);
    expect((await viaProxy('203.0.113.1')).statusCode).toBe(429);
  });
});

describe('TRUST_PROXY', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['true', true],
    ['2', 2],
    ['10.0.0.0/8, 127.0.0.1', '10.0.0.0/8, 127.0.0.1'],
  ])('%j → %j', (value, expected) => {
    const env = { DATABASE_URL: 'postgresql://x@localhost/x', REDIS_URL: 'redis://localhost' };
    expect(loadConfig({ ...env, TRUST_PROXY: value }).TRUST_PROXY).toEqual(expected);
  });

  it('with a hop count, takes the client IP that many proxies back', async () => {
    const app = await makeApp({ config: { ...base, TRUST_PROXY: 1 } });
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
    });
    // One trusted hop (the load balancer at 127.0.0.1): the client is the last forwarded IP.
    expect(res.json()).toEqual({ ip: '198.51.100.7' });
  });
});

describe('unsubscribe page headers', () => {
  it('keeps the tokenized URL out of referrers, caches and frames', async () => {
    const app = await makeApp({
      unsubscribe: { verify: () => true, optOut: async () => true },
    });
    const res = await app.inject({ method: 'GET', url: '/unsubscribe?lead=l&token=t' });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("form-action 'self'");
  });
});
