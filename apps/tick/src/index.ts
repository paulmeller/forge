// Side-effect import — must come first so .env.local is loaded before any
// downstream module evaluates. See bootstrap.ts for the why.
import './bootstrap';

import { env } from './env';
import { buildServer } from './server';
import { syncSkillsToDb } from './skill-loader';

async function main(): Promise<void> {
  const app = await buildServer();

  // Sync the on-disk skill library (skills/*) into the DB at startup so
  // Missions can attach them and the dispatcher can resolve built-in skills
  // (e.g. the triage bug-reproduce/bug-fix pair) by slug. Non-fatal: a sync
  // failure must not stop the tick loop from serving.
  try {
    const { inserted, updated } = await syncSkillsToDb();
    app.log.info({ inserted, updated }, 'skills synced');
  } catch (err) {
    app.log.error({ err: String(err) }, 'skill sync failed');
  }

  try {
    await app.listen({ host: '0.0.0.0', port: env.PORT });
  } catch (err) {
    app.log.error(err, 'failed to start');
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
