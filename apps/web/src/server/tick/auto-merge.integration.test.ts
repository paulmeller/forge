import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// runAutoMerge's candidate-selection query is the exact defect this task
// exists to fix: it must select `ready_to_merge` Tasks and must NEVER select
// `needs_human` Tasks, however small their diff. The unit-mocked
// auto-merge.test.ts fakes `db.select().where(...)` to just return whatever
// the test seeded, ignoring the real WHERE clause entirely — a needs_human
// row seeded there would pass or fail independent of production's
// `eq(tasks.status, 'ready_to_merge')` filter, which is not a real
// regression guard. This file runs the real query against a live SQLite DB
// instead, with only Octokit faked — same DB-integration pattern as
// reconciler-pr.test.ts / budgets.integration.test.ts.

const mockOctokit = vi.hoisted(() => ({
  pulls: { get: vi.fn(), merge: vi.fn(), listFiles: vi.fn() },
  repos: { getBranchProtection: vi.fn() },
  graphql: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

const DB_FILE = `/tmp/forge-auto-merge-int-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;
process.env.GITHUB_APP_TOKEN = 'ghp_test';

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let runAutoMerge: typeof import('./auto-merge').runAutoMerge;

const noopLog = { info: () => {}, warn: () => {} };

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ runAutoMerge } = await import('./auto-merge'));
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
    autoMergePolicy: { enabled: true },
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
    status: 'ready_to_merge',
    prUrl: 'https://github.com/acme/repo/pull/7',
    prNumber: 7,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

describe('runAutoMerge — candidate selection (real query, live SQLite)', () => {
  it('never selects a task that escalated to needs_human', async () => {
    // A task the AI reviewer rejected three times must not be merge-eligible,
    // however small its diff. This is the defect the status split exists to
    // prevent, and the guarantee this test encodes for real: if the
    // candidate query is ever widened back to include needs_human, this
    // fails.
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, {
      status: 'needs_human',
      escalationReason: 'ai_review_rejected',
    });

    const result = await runAutoMerge(noopLog);

    expect(result.candidates).toBe(0);
    expect(mockOctokit.pulls.merge).not.toHaveBeenCalled();
    expect(mockOctokit.graphql).not.toHaveBeenCalled();
  });

  it('does select a ready_to_merge task with a PR url (positive control)', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, { status: 'ready_to_merge' });

    mockOctokit.pulls.get.mockResolvedValue({
      data: {
        state: 'open',
        additions: 5,
        deletions: 2,
        changed_files: 1,
        node_id: 'PR_control',
        base: { ref: 'main' },
      },
    });
    mockOctokit.repos.getBranchProtection.mockResolvedValue({
      data: { required_status_checks: { contexts: ['build'] } },
    });
    mockOctokit.graphql.mockResolvedValue({});

    const result = await runAutoMerge(noopLog);

    expect(result.candidates).toBe(1);
    expect(result.merged).toBe(1);
  });

  it('does not select a queued task, even with a PR url and matching mission', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, { status: 'queued' });

    const result = await runAutoMerge(noopLog);

    expect(result.candidates).toBe(0);
  });
});
