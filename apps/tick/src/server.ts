import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';

import { verifyCloudSchedulerOidc } from './oidc';
import { runTick } from './tick';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    disableRequestLogging: false,
  });

  await app.register(sensible);

  app.get('/healthz', async () => ({ status: 'ok', service: 'forge-tick' }));

  app.post('/tick', async (request, reply) => {
    try {
      await verifyCloudSchedulerOidc(request.headers.authorization);
    } catch (err) {
      request.log.warn({ err }, 'oidc verification failed');
      return reply.unauthorized('oidc verification failed');
    }

    const result = await runTick(request.log);
    request.log.info({ result }, 'tick:done');
    return reply.send(result);
  });

  return app;
}
