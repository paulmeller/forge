import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// #82: cancelling a mission must stop its `awaiting_ci` Tasks from being
// polled at all — not just from merging. runCiPoller's candidate-selection
// query is what's under test here, so (like auto-merge.integration.test.ts)
// this runs the real query against a live SQLite DB with only Octokit faked;
// ci.test.ts's mocked `db.select().where(...)` returns whatever the test
// seeded regardless of the real WHERE clause, so it can't catch a missing
// mission-status filter.

const mockOctokit = vi.hoisted(() => ({
  pulls: { get: vi.fn() },
  checks: { listForRef: vi.fn() },
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

const DB_FILE = `/tmp/forge-ci-int-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;
process.env.GITHUB_APP_TOKEN = 'ghp_test';

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let runCiPoller: typeof import('./ci').runCiPoller;

const noopLog = { info: () => {}, warn: () => {} };

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ runCiPoller } = await import('./ci'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(async () => {
  await db.delete(schema.missions);
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
    repo: 'acme/repo',
    baseBranch: 'main',
    status: 'awaiting_ci',
    prUrl: 'https://github.com/acme/repo/pull/7',
    prNumber: 7,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

describe('runCiPoller — candidate selection (real query, live SQLite)', () => {
  it('does not poll an awaiting_ci task whose mission was cancelled', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, { status: 'cancelled' });
    await insertTask(taskId, missionId);

    const result = await runCiPoller(noopLog);

    expect(result.tasksChecked).toBe(0);
    expect(mockOctokit.pulls.get).not.toHaveBeenCalled();
  });

  it('does poll an awaiting_ci task on a running mission (positive control)', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId);

    mockOctokit.pulls.get.mockResolvedValue({ data: { head: { sha: 'sha_1' } } });
    mockOctokit.checks.listForRef.mockResolvedValue({
      data: { total_count: 0, check_runs: [] },
    });

    const result = await runCiPoller(noopLog);

    expect(result.tasksChecked).toBe(1);
    expect(result.transitionedToReview).toBe(1);
  });
});
