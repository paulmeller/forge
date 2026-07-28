import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// Point the real ./db module at a throwaway libSQL file BEFORE it is imported.
// This suite runs against the actual migrated `deviceCode` table on purpose:
// the thing under test is a conditional UPDATE, and a fake query builder would
// only ever assert that this file built the object this file expected.
const DB_FILE = `/tmp/forge-device-auth-int-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let deviceAuth: typeof import('./device-auth');

const ALICE = 'usr_alice';
const BOB = 'usr_bob';

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  deviceAuth = await import('./device-auth');

  for (const [id, email] of [
    [ALICE, 'alice@example.com'],
    [BOB, 'bob@example.com'],
  ]) {
    await db.run(
      sql`INSERT INTO user (id, name, email) VALUES (${id}, ${id}, ${email})`,
    );
  }
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

beforeEach(async () => {
  await db.delete(schema.deviceCode);
});

const HOUR = 60 * 60 * 1000;

async function seedCode(over: Partial<typeof schema.deviceCode.$inferInsert> = {}) {
  const values = {
    id: `dc_${over.userCode ?? 'AAAABBBB'}`,
    deviceCode: `device_${over.userCode ?? 'AAAABBBB'}`,
    userCode: 'AAAABBBB',
    userId: null,
    expiresAt: Date.now() + HOUR,
    status: 'pending',
    lastPolledAt: null,
    pollingInterval: 5000,
    clientId: deviceAuth.FORGE_CLI_CLIENT_ID,
    scope: null,
    ...over,
  } satisfies typeof schema.deviceCode.$inferInsert;
  await db.insert(schema.deviceCode).values(values);
  return values;
}

async function row(userCode: string) {
  const [found] = await db
    .select()
    .from(schema.deviceCode)
    .where(eq(schema.deviceCode.userCode, userCode));
  return found;
}

describe('decideDeviceRequest — the typed code is what gets acted on', () => {
  it('approves only the code that was typed, leaving every other pending code alone', async () => {
    await seedCode({ id: 'dc_1', deviceCode: 'device_1', userCode: 'AAAABBBB' });
    await seedCode({ id: 'dc_2', deviceCode: 'device_2', userCode: 'CCCCDDDD' });

    const outcome = await deviceAuth.decideDeviceRequest('AAAA-BBBB', ALICE, 'approve');

    expect(outcome.ok).toBe(true);
    expect((await row('AAAABBBB'))?.status).toBe('approved');
    // The other pending code must be untouched — an implementation that
    // approved "whatever is pending" would flip this one too.
    expect((await row('CCCCDDDD'))?.status).toBe('pending');
    expect((await row('CCCCDDDD'))?.userId).toBeNull();
  });

  it('refuses an unknown code even while a pending code exists, rather than falling back to it', async () => {
    await seedCode({ userCode: 'AAAABBBB' });

    const outcome = await deviceAuth.decideDeviceRequest('ZZZZ9999', ALICE, 'approve');

    expect(outcome).toEqual({ ok: false, code: 'NOT_FOUND', error: expect.any(String) });
    expect((await row('AAAABBBB'))?.status).toBe('pending');
  });

  it('refuses an empty typed code rather than falling back to the pending one', async () => {
    await seedCode({ userCode: 'AAAABBBB' });

    const outcome = await deviceAuth.decideDeviceRequest('   ', ALICE, 'approve');

    expect(outcome.ok).toBe(false);
    expect((await row('AAAABBBB'))?.status).toBe('pending');
    expect((await row('AAAABBBB'))?.userId).toBeNull();
  });
});

describe('decideDeviceRequest — ownership', () => {
  // Step 6. `/device/token` issues `createSession(deviceCode.userId)`, so the
  // row's `userId` IS the identity the CLI ends up holding. These two tests
  // pin both halves of that: the approver is who gets bound, and nobody can
  // rebind afterwards.
  it('binds the row to the user who approved it', async () => {
    await seedCode();

    await deviceAuth.decideDeviceRequest('AAAABBBB', ALICE, 'approve');

    const bound = await row('AAAABBBB');
    expect(bound?.status).toBe('approved');
    expect(bound?.userId).toBe(ALICE);
  });

  it('never lets a second user rebind a code the first user already approved', async () => {
    await seedCode();
    const first = await deviceAuth.decideDeviceRequest('AAAABBBB', ALICE, 'approve');
    expect(first.ok).toBe(true);

    const second = await deviceAuth.decideDeviceRequest('AAAABBBB', BOB, 'approve');

    expect(second).toEqual({ ok: false, code: 'ALREADY_DECIDED', error: expect.any(String) });
    const bound = await row('AAAABBBB');
    expect(bound?.userId).toBe(ALICE);
    expect(bound?.status).toBe('approved');
  });

  it('never lets a second user approve a code the first user denied', async () => {
    await seedCode();
    await deviceAuth.decideDeviceRequest('AAAABBBB', ALICE, 'deny');

    const second = await deviceAuth.decideDeviceRequest('AAAABBBB', BOB, 'approve');

    expect(second.ok).toBe(false);
    const bound = await row('AAAABBBB');
    expect(bound?.status).toBe('denied');
    expect(bound?.userId).toBe(ALICE);
  });
});

describe('decideDeviceRequest — deny', () => {
  it('marks the code denied and binds it to the denier so it can never be approved later', async () => {
    await seedCode();

    const outcome = await deviceAuth.decideDeviceRequest('AAAA-BBBB', ALICE, 'deny');

    expect(outcome).toEqual({ ok: true, decision: 'deny', clientId: deviceAuth.FORGE_CLI_CLIENT_ID });
    const denied = await row('AAAABBBB');
    expect(denied?.status).toBe('denied');
    expect(denied?.userId).toBe(ALICE);
  });

  it('refuses to deny a code that was already approved', async () => {
    await seedCode();
    await deviceAuth.decideDeviceRequest('AAAABBBB', ALICE, 'approve');

    const outcome = await deviceAuth.decideDeviceRequest('AAAABBBB', ALICE, 'deny');

    expect(outcome.ok).toBe(false);
    expect((await row('AAAABBBB'))?.status).toBe('approved');
  });
});

describe('decideDeviceRequest — expiry and client', () => {
  it('refuses an expired code', async () => {
    await seedCode({ expiresAt: Date.now() - 1000 });

    const outcome = await deviceAuth.decideDeviceRequest('AAAABBBB', ALICE, 'approve');

    expect(outcome).toEqual({ ok: false, code: 'EXPIRED', error: expect.any(String) });
    expect((await row('AAAABBBB'))?.status).toBe('pending');
  });

  it('approves a code that has not expired yet', async () => {
    await seedCode({ expiresAt: Date.now() + 1000 });

    const outcome = await deviceAuth.decideDeviceRequest('AAAABBBB', ALICE, 'approve');

    expect(outcome.ok).toBe(true);
  });

  it('refuses a code whose stored client id is no longer on the allow-list', async () => {
    await seedCode({ clientId: 'attacker-cli' });

    const outcome = await deviceAuth.decideDeviceRequest('AAAABBBB', ALICE, 'approve');

    expect(outcome).toEqual({ ok: false, code: 'INVALID_CLIENT', error: expect.any(String) });
    expect((await row('AAAABBBB'))?.status).toBe('pending');
  });

  it('refuses a code with no client id at all', async () => {
    await seedCode({ clientId: null });

    const outcome = await deviceAuth.decideDeviceRequest('AAAABBBB', ALICE, 'approve');

    expect(outcome.ok).toBe(false);
    expect((await row('AAAABBBB'))?.status).toBe('pending');
  });
});

describe('findDeviceRequest — what the consent page shows', () => {
  it('returns the requesting client and scope for a pending code', async () => {
    await seedCode();

    const found = await deviceAuth.findDeviceRequest('AAAA-BBBB');

    expect(found).toEqual({
      userCode: 'AAAABBBB',
      clientId: deviceAuth.FORGE_CLI_CLIENT_ID,
      scope: null,
    });
  });

  it('returns null for an unknown code instead of the pending one', async () => {
    await seedCode();
    expect(await deviceAuth.findDeviceRequest('ZZZZ9999')).toBeNull();
  });

  it('returns null for an expired code', async () => {
    await seedCode({ expiresAt: Date.now() - 1 });
    expect(await deviceAuth.findDeviceRequest('AAAABBBB')).toBeNull();
  });

  it('returns null for a code that was already decided', async () => {
    await seedCode({ status: 'approved', userId: ALICE });
    expect(await deviceAuth.findDeviceRequest('AAAABBBB')).toBeNull();
  });

  it('returns null for a code from a client that is not allow-listed', async () => {
    await seedCode({ clientId: 'attacker-cli' });
    expect(await deviceAuth.findDeviceRequest('AAAABBBB')).toBeNull();
  });
});
