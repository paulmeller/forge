import { createDatabase } from '@forge/db';

import { env } from './env';

export const { db, client } = createDatabase({
  url: env.DATABASE_URL,
  authToken: env.DATABASE_AUTH_TOKEN,
});
