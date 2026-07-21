import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// tryOpenPr (reconciler.ts) is the server-side fallback that opens a real PR via Octokit
// when an agent pushes a branch but never calls the GitHub MCP create_pull_request tool
// itself. It's exercised here through runReconciler end-to-end against a real libSQL file,
// with only the Octokit client faked — same DB-integration pattern as reconciler.test.ts.
const mockOctokit = vi.hoisted(() => ({
  repos: {
    listBranches: vi.fn(async () => ({ data: [] as Array<{ name: string }> })),
    compareCommits: vi.fn(),
  },
  pulls: {
    list: vi.fn(),
    create: vi.fn(),
  },
  issues: {
    get: vi.fn(),
  },
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

const DB_FILE = `/tmp/forge-recon-pr-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;
process.env.GATE_STALL_MS = '999999999'; // don't let the stall sweep interfere
process.env.GITHUB_APP_TOKEN = 'ghp_test';

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let runReconciler: typeof import('./reconciler').runReconciler;

const noopLog = { info: () => {}, warn: () => {} };

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ runReconciler } = await import('./reconciler'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(() => {
  vi.clearAllMocks();
  mockOctokit.repos.listBranches.mockResolvedValue({ data: [] });
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

async function insertStalledTask(id: string, missionId: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    status: 'turn_ended',
    prUrl: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function getTask(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return row;
}

async function getLedgerEvents(taskId: string) {
  return db.select().from(schema.ledgerEvents).where(eq(schema.ledgerEvents.taskId, taskId));
}

describe('runReconciler — PR-opening gate (tryOpenPr)', () => {
  it('records an already-open PR via pulls.list without creating a new one', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId);

    mockOctokit.repos.compareCommits.mockResolvedValue({
      data: { ahead_by: 2, total_commits: 2, files: [] },
    });
    mockOctokit.pulls.list.mockResolvedValue({
      data: [{ number: 42, html_url: 'https://github.com/acme/api/pull/42' }],
    });

    await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('awaiting_ci');
    expect(task?.prNumber).toBe(42);
    expect(task?.prUrl).toBe('https://github.com/acme/api/pull/42');
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('creates a PR via pulls.create when none exists, and emits gate.pr_opened', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, { name: 'Test mission' });
    await insertStalledTask(taskId, missionId, { issueRef: null });

    mockOctokit.repos.compareCommits.mockResolvedValue({
      data: { ahead_by: 1, total_commits: 1, files: [{ filename: 'a.ts' }] },
    });
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });
    mockOctokit.pulls.create.mockResolvedValue({
      data: { number: 7, html_url: 'https://github.com/acme/api/pull/7' },
    });

    await runReconciler(noopLog);

    expect(mockOctokit.pulls.create).toHaveBeenCalledTimes(1);
    const createArgs = mockOctokit.pulls.create.mock.calls[0]![0];
    expect(createArgs).toMatchObject({
      owner: 'acme',
      repo: 'api',
      head: `forge/${taskId}`,
      base: 'main',
      title: 'Forge: Test mission',
    });
    expect(mockOctokit.issues.get).not.toHaveBeenCalled();

    const task = await getTask(taskId);
    expect(task?.status).toBe('awaiting_ci');
    expect(task?.prNumber).toBe(7);
    expect(task?.prUrl).toBe('https://github.com/acme/api/pull/7');

    const events = await getLedgerEvents(taskId);
    const opened = events.find((e) => e.eventType === 'gate.pr_opened');
    expect(opened).toBeDefined();
    expect(opened?.payload).toMatchObject({
      prNumber: 7,
      prUrl: 'https://github.com/acme/api/pull/7',
      branch: `forge/${taskId}`,
      aheadBy: 1,
      openedBy: 'forge-reconciler',
    });
  });

  it('abandons the task when no branch with commits ahead of base is found', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId);

    // Every candidate branch compares as even with base — nothing was ever pushed.
    mockOctokit.repos.compareCommits.mockResolvedValue({ data: { ahead_by: 0 } });

    await runReconciler(noopLog);

    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();

    const task = await getTask(taskId);
    expect(task?.status).toBe('abandoned');

    const events = await getLedgerEvents(taskId);
    const abandoned = events.find((e) => e.eventType === 'task.abandoned');
    expect(abandoned?.payload).toMatchObject({
      reason: 'turn_ended with no PR and no branch found',
    });
  });
});
