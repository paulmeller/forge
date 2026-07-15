import { Readable } from 'node:stream';

import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { eq } from 'drizzle-orm';

import { tasks } from '@forge/db';

import { db } from './db';
import { env } from './env';
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

  // Live run view (docs/superpowers/specs/2026-07-16-live-run-view-design.md).
  // Proxies the Managed Agents engine's real session event stream through to
  // the caller (apps/web's own SSE route) as a raw passthrough — no
  // transformation, no persistence. Separate code path from the cron-driven
  // /tick handler above; only active while something is connected.
  app.get<{ Params: { taskId: string } }>('/tasks/:taskId/stream', async (request, reply) => {
    const { taskId } = request.params;

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) return reply.notFound(`no task ${taskId}`);
    if (!task.sessionId) return reply.notFound(`task ${taskId} has no session yet`);

    let upstream: Response;
    try {
      upstream = await fetch(
        `${env.ANTHROPIC_BASE_URL}/v1/sessions/${task.sessionId}/events/stream`,
        {
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY ?? '',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'managed-agents-2026-04-01',
          },
        },
      );
    } catch (err) {
      request.log.warn({ err }, 'engine stream fetch failed');
      return reply.code(502).send({ error: 'upstream stream unavailable' });
    }

    if (!upstream.ok || !upstream.body) {
      return reply.code(upstream.status || 502).send({ error: 'upstream stream unavailable' });
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const nodeStream = Readable.fromWeb(upstream.body as never);
    nodeStream.pipe(reply.raw);
    request.raw.on('close', () => nodeStream.destroy());

    return reply;
  });

  return app;
}
