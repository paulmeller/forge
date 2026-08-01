import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// #84: while a mission's auto-merge policy is disabled (the normal case —
// auto-merge is opt-in), a human merging a Task's PR by hand via `gh` is the
// NORMAL workflow, not an edge case. Nothing in the tick previously noticed:
// `ready_to_merge` just waits forever for a `runAutoMerge` pass that will
// never come (policy disabled), and `needs_human` waits forever for a person
// regardless of why it escalated. Both hold a container concurrency slot
// (INFLIGHT_STATUSES in dispatcher.ts) indefinitely — observed live as six
// zombie Tasks pinning a five-slot container, with claimNextBatch computing
// zero slots forever and no signal anywhere. Exercised against a real
// libSQL file with only Octokit faked — same pattern as
// reconciler-merge.test.ts's `merging` sweep.
const mockOctokit = vi.hoisted(() => ({
  pulls: {
    get: vi.fn(),
  },
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

const DB_FILE = `/tmp/forge-recon-extmerge-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;
process.env.GATE_STALL_MS = '999999999'; // don't let the stall sweep interfere
process.env.MERGE_STALL_MS = '999999999'; // ditto
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
});

// The settle sweep scans across ALL Tasks, not just the current test's
// mission (same as the merging sweep it sits next to) — a leftover
// ready_to_merge/needs_human row from a prior test would otherwise get
// swept again here and pollute an unrelated assertion. Missions cascade to
// tasks (schema.ts's onDelete: 'cascade'), so clearing missions is enough.
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
    repo: 'acme/api',
    baseBranch: 'main',
    status: 'ready_to_merge',
    prUrl: 'https://github.com/acme/api/pull/22',
    prNumber: 22,
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

describe('runReconciler — external-merge settle sweep (#84)', () => {
  it('settles a ready_to_merge Task to merged when GitHub reports its PR merged', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, { status: 'ready_to_merge' });

    mockOctokit.pulls.get.mockResolvedValue({ data: { state: 'closed', merged: true } });

    const result = await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('merged');
    expect(task?.completedAt).not.toBeNull();
    expect(result.externalMergesSettled).toBe(1);

    const events = await getLedgerEvents(taskId);
    const settled = events.find((e) => e.eventType === 'task.externally_merged');
    expect(settled).toBeDefined();
    expect(settled?.payload).toMatchObject({ prNumber: 22, from: 'ready_to_merge' });
  });

  it('settles a zombie needs_human Task to merged when GitHub reports its PR merged', async () => {
    // The exact shape observed live in #84: a Task escalated for an unrelated
    // reason (merge_stall here) whose PR a human merged by hand, holding an
    // INFLIGHT_STATUSES slot forever with nothing noticing.
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, {
      status: 'needs_human',
      escalationReason: 'merge_stall',
      lastError: 'merge stalled in ready_to_merge for >1000ms',
    });

    mockOctokit.pulls.get.mockResolvedValue({ data: { state: 'closed', merged: true } });

    const result = await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('merged');
    expect(task?.escalationReason).toBeNull();
    expect(result.externalMergesSettled).toBe(1);
  });

  it('leaves a ready_to_merge Task alone when its PR is still open', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, { status: 'ready_to_merge' });

    mockOctokit.pulls.get.mockResolvedValue({ data: { state: 'open', merged: false } });

    const result = await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('ready_to_merge');
    expect(result.externalMergesSettled).toBe(0);
  });

  it('leaves a needs_human Task with no PR alone', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, {
      status: 'needs_human',
      escalationReason: 'ai_review_rejected',
      prUrl: null,
      prNumber: null,
    });

    const result = await runReconciler(noopLog);

    expect(mockOctokit.pulls.get).not.toHaveBeenCalled();
    const task = await getTask(taskId);
    expect(task?.status).toBe('needs_human');
    expect(result.externalMergesSettled).toBe(0);
  });
});
