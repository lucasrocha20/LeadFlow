import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ReadinessCheck } from '../src/routes/health.js';
import { testAppDeps } from './helpers.js';

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

async function makeApp(readinessChecks: Record<string, ReadinessCheck>) {
  app = await buildApp(testAppDeps({ readinessChecks }));
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns 200 even when dependencies are down', async () => {
    const app = await makeApp({ database: () => Promise.reject(new Error('down')) });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /health/ready', () => {
  it('returns 200 when all checks pass', async () => {
    const app = await makeApp({ database: async () => {} });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('returns 503 when a check fails', async () => {
    const app = await makeApp({
      database: () => Promise.reject(new Error('connection refused')),
    });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', checks: { database: 'error' } });
  });
});
