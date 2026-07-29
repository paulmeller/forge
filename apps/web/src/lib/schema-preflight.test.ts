import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, describe, expect, it } from 'vitest';

import { findMissingTables } from './schema-preflight';

/**
 * The gap this closes was found the first time the device flow was called
 * against a real server: the local database was two migrations behind, so
 * `deviceCode` did not exist and POST /api/auth/device/code answered a bare
 * 500 with nothing to diagnose from. 1,033 unit tests passed while the first
 * real HTTP request failed, because every one of them builds its own schema.
 *
 * A schema behind the code is not an exotic condition — it is what a pulled
 * branch, a skipped `db:migrate`, or a half-applied deploy looks like.
 */
const dbs: { close: () => void }[] = [];

function tempDb(create: string[]) {
  const client = createClient({ url: ':memory:' });
  dbs.push(client);
  for (const stmt of create) client.execute(stmt);
  return drizzle(client);
}

afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

describe('findMissingTables', () => {
  it('names every declared table the database does not have', async () => {
    const db = tempDb(['CREATE TABLE missions (id text primary key)']);
    const missing = await findMissingTables(db, ['missions', 'tasks', 'deviceCode']);
    expect(missing).toEqual(['tasks', 'deviceCode']);
  });

  it('returns nothing when the database has every declared table', async () => {
    // The positive direction matters as much as the negative one: a predicate
    // that always reports "missing" would satisfy the test above and block
    // every boot.
    const db = tempDb([
      'CREATE TABLE missions (id text primary key)',
      'CREATE TABLE tasks (id text primary key)',
    ]);
    expect(await findMissingTables(db, ['missions', 'tasks'])).toEqual([]);
  });

  it('is case-sensitive, because deviceCode is not devicecode', async () => {
    // The one table on this schema with a camelCase name is exactly the one
    // whose absence caused the 500.
    const db = tempDb(['CREATE TABLE devicecode (id text primary key)']);
    expect(await findMissingTables(db, ['deviceCode'])).toEqual(['deviceCode']);
  });

  it('ignores sqlite internal tables rather than reporting them as extra', async () => {
    const db = tempDb(['CREATE TABLE missions (id text primary key)']);
    expect(await findMissingTables(db, ['missions'])).toEqual([]);
  });
});
