import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// Real migrated table, real DELETE — see device-auth.integration.test.ts for
// why a fake query builder would prove nothing about a WHERE clause.
const DB_FILE = `/tmp/forge-device-sweep-int-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let runDeviceCodeSweep: typeof import('./device-codes').runDeviceCodeSweep;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ runDeviceCodeSweep } = await import('./device-codes'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(schema.deviceCode);
});

async function seed(id: string, expiresAt: number, status = 'pending') {
  await db.insert(schema.deviceCode).values({
    id,
    deviceCode: `device_${id}`,
    userCode: id.toUpperCase().padEnd(8, 'X').slice(0, 8),
    userId: null,
    expiresAt,
    status,
    lastPolledAt: null,
    pollingInterval: 5000,
    clientId: 'forge-cli',
    scope: null,
  });
}

async function remaining(): Promise<string[]> {
  const rows = await db.select({ id: schema.deviceCode.id }).from(schema.deviceCode);
  return rows.map((r) => r.id).sort();
}

describe('runDeviceCodeSweep', () => {
  // `/device/code` is unauthenticated and the plugin only deletes a row when
  // it is polled after expiry, denied-then-polled, or exchanged. A code that
  // is created and never polled is never collected by anything else, so
  // without this sweep the table grows without bound.
  it('deletes codes whose expiry has passed', async () => {
    await seed('dc_old', Date.now() - 60_000);

    const result = await runDeviceCodeSweep(log);

    expect(result).toEqual({ deleted: 1 });
    expect(await remaining()).toEqual([]);
  });

  it('leaves codes that have not expired yet', async () => {
    await seed('dc_live', Date.now() + 60_000);

    const result = await runDeviceCodeSweep(log);

    expect(result).toEqual({ deleted: 0 });
    expect(await remaining()).toEqual(['dc_live']);
  });

  it('sweeps only the expired rows when both kinds are present', async () => {
    await seed('dc_old', Date.now() - 1);
    await seed('dc_live', Date.now() + 60_000);

    const result = await runDeviceCodeSweep(log);

    expect(result).toEqual({ deleted: 1 });
    expect(await remaining()).toEqual(['dc_live']);
  });

  it('collects expired codes that were approved but never exchanged', async () => {
    // The approved-but-abandoned row is the one nothing else ever deletes:
    // the CLI that would have exchanged it is gone, so `/device/token` will
    // never be called for it.
    await seed('dc_appr', Date.now() - 1, 'approved');
    await seed('dc_deny', Date.now() - 1, 'denied');

    const result = await runDeviceCodeSweep(log);

    expect(result).toEqual({ deleted: 2 });
    expect(await remaining()).toEqual([]);
  });

  it('reports nothing and touches nothing on an empty table', async () => {
    const result = await runDeviceCodeSweep(log);
    expect(result).toEqual({ deleted: 0 });
    expect(log.info).not.toHaveBeenCalled();
  });
});
