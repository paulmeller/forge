import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

describe('resolveGateFlags', () => {
  // Point the real ./db module at a throwaway libSQL file BEFORE it is
  // imported (mirrors apps/tick/src/reconciler.test.ts).
  const DB_FILE = `/tmp/forge-gate-flags-${process.pid}.db`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
  process.env.DATABASE_URL = `file:${DB_FILE}`;

  let db: LibSQLDatabase<Record<string, unknown>>;
  let client: { close: () => void };
  let schema: typeof import('@forge/db');
  let resolveGateFlags: typeof import('./gate-flags').resolveGateFlags;

  beforeAll(async () => {
    const dbMod = await import('./db');
    db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
    client = dbMod.client as unknown as { close: () => void };
    await migrate(dbMod.db, {
      migrationsFolder: resolve(__dirname, '../../../packages/db/migrations'),
    });
    schema = await import('@forge/db');
    ({ resolveGateFlags } = await import('./gate-flags'));
  });

  afterAll(() => {
    client.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
    }
  });

  async function insertMission(id: string, over: Record<string, unknown> = {}) {
    const now = new Date();
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
      ...over,
    });
  }

  it('reads the parent container flags for an issue-leaf mission', async () => {
    await insertMission('container_1', {
      aiReviewEnabled: true,
      selfVerifyEnabled: true,
    });
    await insertMission('leaf_1', {
      parentMissionId: 'container_1',
      // Leaves are created with both flags hardcoded false — the bug being fixed.
      aiReviewEnabled: false,
      selfVerifyEnabled: false,
    });

    const flags = await resolveGateFlags('leaf_1');
    expect(flags).toEqual({ aiReviewEnabled: true, selfVerifyEnabled: true });
  });

  it('uses a standalone mission own flags when it has no parent', async () => {
    await insertMission('campaign_1', {
      aiReviewEnabled: true,
      selfVerifyEnabled: false,
    });

    const flags = await resolveGateFlags('campaign_1');
    expect(flags).toEqual({ aiReviewEnabled: true, selfVerifyEnabled: false });
  });

  it('falls back to the leaf own flags when the parent row is missing', async () => {
    await insertMission('orphan_leaf', {
      parentMissionId: 'no_such_container',
      aiReviewEnabled: true,
      selfVerifyEnabled: false,
    });

    const flags = await resolveGateFlags('orphan_leaf');
    expect(flags).toEqual({ aiReviewEnabled: true, selfVerifyEnabled: false });
  });

  it('returns false defaults when the mission itself is missing', async () => {
    const flags = await resolveGateFlags('nonexistent');
    expect(flags).toEqual({ aiReviewEnabled: false, selfVerifyEnabled: false });
  });

  it('reflects a container flag change made after the leaf was created (live settings)', async () => {
    await insertMission('container_2', {
      aiReviewEnabled: false,
      selfVerifyEnabled: false,
    });
    await insertMission('leaf_2', {
      parentMissionId: 'container_2',
      aiReviewEnabled: false,
      selfVerifyEnabled: false,
    });

    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.missions)
      .set({ aiReviewEnabled: true })
      .where(eq(schema.missions.id, 'container_2'));

    const flags = await resolveGateFlags('leaf_2');
    expect(flags).toEqual({ aiReviewEnabled: true, selfVerifyEnabled: false });
  });
});
