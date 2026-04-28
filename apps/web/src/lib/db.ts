import { createDatabase } from '@forge/db';

import { env } from './env';

const globalForDb = globalThis as unknown as {
  forgeDb?: ReturnType<typeof createDatabase>;
};

export const { db, client } =
  globalForDb.forgeDb ??
  (globalForDb.forgeDb = createDatabase({
    url: env.DATABASE_URL,
    authToken: env.DATABASE_AUTH_TOKEN,
  }));
