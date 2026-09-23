import Fastify from 'fastify';
import type { CaptureLead } from './capture/captureLead.js';
import type { FormAdapter } from './capture/types.js';
import { loggerOptions, type LoggerConfig } from './logger.js';
import { healthRoutes, type ReadinessCheck } from './routes/health.js';
import { webhookRoutes } from './routes/webhooks.js';

export interface AppDeps {
  config: LoggerConfig;
  readinessChecks: Record<string, ReadinessCheck>;
  formAdapters: Record<string, FormAdapter>;
  captureLead: CaptureLead;
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
