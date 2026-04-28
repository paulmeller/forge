import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';

import * as schema from './schema';

export type Database = LibSQLDatabase<typeof schema>;

export type CreateDatabaseOptions = {
  url: string;
  authToken?: string;
};

export function createDatabase({ url, authToken }: CreateDatabaseOptions): {
  db: Database;
  client: Client;
} {
  const client = createClient({ url, authToken });
  const db = drizzle(client, { schema });
  return { db, client };
}

export { schema };
