import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AutoMergePolicy } from '@forge/db';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';

describe('resolveAutoMergePolicy', () => {
  // Point the real ./db module at a throwaway libSQL file BEFORE it is
  // imported (mirrors apps/tick/src/reconciler.test.ts and gate-flags.test.ts).
  const DB_FILE = `/tmp/forge-auto-merge-policy-${process.pid}.db`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
  process.env.DATABASE_URL = `file:${DB_FILE}`;

  let db: LibSQLDatabase<Record<string, unknown>>;
  let client: { close: () => void };
  let schema: typeof import('@forge/db');
  let resolveAutoMergePolicy: typeof import('./auto-merge-policy').resolveAutoMergePolicy;

  beforeAll(async () => {
    const dbMod = await import('@/lib/db');
    db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
    client = dbMod.client as unknown as { close: () => void };
    await migrate(dbMod.db, {
      migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
    });
    schema = await import('@forge/db');
    ({ resolveAutoMergePolicy } = await import('./auto-merge-policy'));
  });

  afterAll(() => {
    client.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
    }
  });

  async function seedMission(over: {
    id: string;
    parentMissionId?: string | null;
    autoMergePolicy?: AutoMergePolicy | null;
  }) {
    const now = new Date();
    const { id, parentMissionId = null, autoMergePolicy = null, ...rest } = over;
    await db.insert(schema.missions).values({
      id,
      userId: 'user_1',
      name: 'Test mission',
      goal: 'test',
      status: 'running',
      backend: 'managed-agents',
      agentId: 'agent_1',
      plannerStrategy: 'triage',
      webhookSecret: 'secret',
      createdAt: now,
      updatedAt: now,
      parentMissionId,
      autoMergePolicy,
      ...rest,
    });
  }

  it('returns a standalone mission its own policy', async () => {
    await seedMission({ id: 'm_solo', parentMissionId: null, autoMergePolicy: { enabled: true, maxAdditions: 10 } });
    expect(await resolveAutoMergePolicy('m_solo')).toEqual({ enabled: true, maxAdditions: 10 });
  });

  it("returns the CONTAINER's policy for an issue leaf, not the leaf's own", async () => {
    // The live-lookup property: enabling auto-merge on a repo must take
    // effect for leaves that already exist, without recreating them.
    await seedMission({ id: 'm_container', parentMissionId: null, autoMergePolicy: { enabled: true, maxAdditions: 5 } });
    await seedMission({ id: 'm_leaf', parentMissionId: 'm_container', autoMergePolicy: null });
    expect(await resolveAutoMergePolicy('m_leaf')).toEqual({ enabled: true, maxAdditions: 5 });
  });

  it("prefers the container's policy even when the leaf has one of its own", async () => {
    await seedMission({ id: 'm_c2', parentMissionId: null, autoMergePolicy: { enabled: false } });
    await seedMission({ id: 'm_l2', parentMissionId: 'm_c2', autoMergePolicy: { enabled: true } });
    expect(await resolveAutoMergePolicy('m_l2')).toEqual({ enabled: false });
  });

  it("falls back to the leaf's own policy when the parent row is missing", async () => {
    await seedMission({ id: 'm_orphan', parentMissionId: 'm_gone', autoMergePolicy: { enabled: true } });
    expect(await resolveAutoMergePolicy('m_orphan')).toEqual({ enabled: true });
  });

  it('returns null for a mission that does not exist', async () => {
    expect(await resolveAutoMergePolicy('m_missing')).toBeNull();
  });

  it('returns null when no policy is configured anywhere', async () => {
    await seedMission({ id: 'm_nopolicy', parentMissionId: null, autoMergePolicy: null });
    expect(await resolveAutoMergePolicy('m_nopolicy')).toBeNull();
  });
});
