import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-home-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let getNeedsYou: typeof import('./home').getNeedsYou;
let getNowRunning: typeof import('./home').getNowRunning;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ getNeedsYou, getNowRunning } = await import('./home'));
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
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function insertTask(id: string, missionId: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    kind: 'standard',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

describe('getNeedsYou', () => {
  // C1 visibility fix: before this, a ready_to_merge Task appeared in none
  // of NOW_RUNNING_STATUSES / NEEDS_YOU_STATUSES / RECENT_OUTCOME_STATUSES —
  // invisible on /home regardless of whether anything would ever act on it.
  // Revert the NEEDS_YOU_STATUSES addition and this test fails: the task is
  // missing from getNeedsYou's rows.
  it('surfaces a ready_to_merge Task', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask('tsk_needs_you_rtm', missionId, { status: 'ready_to_merge' });

    const rows = await getNeedsYou('user_1');
    expect(rows.map((r) => r.task.id)).toContain('tsk_needs_you_rtm');
  });

  it('does not surface a ready_to_merge Task from getNowRunning (it belongs to Needs You, not Working)', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask('tsk_not_running_rtm', missionId, { status: 'ready_to_merge' });

    const rows = await getNowRunning('user_1');
    expect(rows.map((r) => r.task.id)).not.toContain('tsk_not_running_rtm');
  });
});
