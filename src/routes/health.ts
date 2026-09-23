import type { FastifyPluginAsync } from 'fastify';

export type ReadinessCheck = () => Promise<void>;

interface HealthRoutesOptions {
  checks: Record<string, ReadinessCheck>;
}

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, { checks }) => {
  // Liveness: the process is up and serving requests.
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: dependencies (database, ...) are reachable.
  app.get('/health/ready', async (request, reply) => {
    const results: Record<string, 'ok' | 'error'> = {};
    await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await check();
          results[name] = 'ok';
        } catch (err) {
          request.log.error({ err, check: name }, 'readiness check failed');
          results[name] = 'error';
        }
      }),
    );

    const ready = Object.values(results).every((r) => r === 'ok');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'error', checks: results });
  });
};
