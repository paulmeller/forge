import pino from 'pino';

import { env } from '@/lib/env';
import { verifyCloudSchedulerOidc } from '@/server/tick/oidc';
import { runTick } from '@/server/tick/tick';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cloud Scheduler's cron target (consolidation spec §B) — the merged home of
 * forge-tick's POST /tick. OIDC-verified, then one full runTick() pass.
 */
export async function POST(request: Request) {
  const log = pino({ level: env.LOG_LEVEL });
  try {
    await verifyCloudSchedulerOidc(request.headers.get('authorization') ?? undefined);
  } catch (err) {
    log.warn({ err: String(err) }, 'oidc verification failed');
    return Response.json({ error: 'oidc verification failed' }, { status: 401 });
  }

  const result = await runTick(log);
  log.info({ result }, 'tick:done');
  return Response.json(result);
}
