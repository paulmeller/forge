// Side-effect import — must come first so .env.local is loaded before any
// downstream module evaluates. See bootstrap.ts for the why.
import './bootstrap';

import { env } from './env';
import { buildServer } from './server';

async function main(): Promise<void> {
  const app = await buildServer();
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
