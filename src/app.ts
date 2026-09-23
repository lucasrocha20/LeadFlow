import Fastify, { type FastifyServerOptions } from 'fastify';
import type { CaptureLead } from './capture/captureLead.js';
import type { FormAdapter } from './capture/types.js';
import type { Config } from './config.js';
import { healthRoutes, type ReadinessCheck } from './routes/health.js';
import { webhookRoutes } from './routes/webhooks.js';

export interface AppDeps {
  config: Pick<Config, 'NODE_ENV' | 'LOG_LEVEL'>;
  readinessChecks: Record<string, ReadinessCheck>;
  formAdapters: Record<string, FormAdapter>;
  captureLead: CaptureLead;
}

function loggerOptions(config: AppDeps['config']): FastifyServerOptions['logger'] {
  if (config.NODE_ENV === 'test') return false;
  if (config.NODE_ENV === 'development') {
    return { level: config.LOG_LEVEL, transport: { target: 'pino-pretty' } };
  }
  return { level: config.LOG_LEVEL };
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: loggerOptions(deps.config) });

  await app.register(healthRoutes, { checks: deps.readinessChecks });
  await app.register(webhookRoutes, {
    formAdapters: deps.formAdapters,
    captureLead: deps.captureLead,
  });

  return app;
}
