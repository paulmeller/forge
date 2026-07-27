import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-rollups-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let rollupMissions: typeof import('./rollups').rollupMissions;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ rollupMissions } = await import('./rollups'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

async function insertMission(id: string) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id,
    userId: 'user_1',
    name: 'Test mission',
    goal: 'test',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
  });
}

async function insertTask(id: string, missionId: string, status: string) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    kind: 'standard',
    status: status as never,
    createdAt: now,
    updatedAt: now,
  });
}

describe('rollupMissions', () => {
  // C1 visibility fix: ready_to_merge belongs in the same "awaiting review"
  // bucket as needs_human — waiting on a human or the next tick's
  // runAutoMerge, not silently in-flight. Revert the `|| row.status ===
  // 'ready_to_merge'` branch and this test fails: awaitingReview comes back
  // 0 instead of 1.
  it('counts a ready_to_merge Task in awaitingReview, alongside needs_human', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask('tsk_rollup_rtm', missionId, 'ready_to_merge');
    await insertTask('tsk_rollup_needs_human', missionId, 'needs_human');

    const rollups = await rollupMissions([missionId]);
    expect(rollups.get(missionId)?.awaitingReview).toBe(2);
  });
});
