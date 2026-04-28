import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';

import { createDatabase } from './client';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const authToken = process.env.DATABASE_AUTH_TOKEN;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '..', 'migrations');

  const { db, client } = createDatabase({ url, authToken });
  console.log(`applying migrations from ${migrationsFolder} to ${url}`);
  await migrate(db, { migrationsFolder });
  client.close();
  console.log('done');
}

void main().catch((err) => {
  console.error('migrate failed:', err);
  process.exit(1);
});
