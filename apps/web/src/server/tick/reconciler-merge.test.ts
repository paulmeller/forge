import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// `merging` is what a Task sits in once auto-merge.ts's tryMerge ARMS
// GitHub's native auto-merge (the `enablePullRequestAutoMerge` GraphQL
// mutation) — GitHub decides when, or whether, the PR actually merges.
// Nothing else moves the Task on: the Forge GitHub App isn't subscribed to
// the `pull_request` webhook event, so this reconciler sweep is the only
// real path off `merging`. Exercised end-to-end against a real libSQL file
// with only the Octokit client faked — same pattern as reconciler-pr.test.ts.
const mockOctokit = vi.hoisted(() => ({
  pulls: {
    get: vi.fn(),
  },
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

const DB_FILE = `/tmp/forge-recon-merge-${process.pid}.db`;
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

async function insertMergingTask(id: string, missionId: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    status: 'merging',
    prUrl: 'https://github.com/acme/api/pull/42',
    prNumber: 42,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function getTask(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return row;
}

async function getMission(id: string) {
  const [row] = await db.select().from(schema.missions).where(eq(schema.missions.id, id)).limit(1);
  return row;
}

async function getLedgerEvents(taskId: string) {
  return db.select().from(schema.ledgerEvents).where(eq(schema.ledgerEvents.taskId, taskId));
}

describe('runReconciler — merging sweep (armed auto-merge reconciliation)', () => {
  it('moves the Task to merged, sets completedAt, and writes a ledger event when GitHub reports the PR merged', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertMergingTask(taskId, missionId);

    mockOctokit.pulls.get.mockResolvedValue({ data: { state: 'closed', merged: true } });

    const result = await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('merged');
    expect(task?.completedAt).not.toBeNull();
    expect(result.mergesCompleted).toBe(1);

    const events = await getLedgerEvents(taskId);
    const merged = events.find((e) => e.eventType === 'auto_merge.merged');
    expect(merged).toBeDefined();
    expect(merged?.payload).toMatchObject({ prNumber: 42 });
  });

  // Cheap hardening: every other exit from `merging`/`ready_to_merge`
  // clears approvedBy — this is the one success path no prior invariant
  // test drove a row through, so the scan gave false assurance exactly
  // where it was unfixed. Revert the `approvedBy: null` on this branch and
  // this test fails: the stale approval survives onto the merged row.
  it('clears a stale approvedBy when the sweep confirms the PR merged', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertMergingTask(taskId, missionId, { approvedBy: 'u1' });

    mockOctokit.pulls.get.mockResolvedValue({ data: { state: 'closed', merged: true } });

    await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('merged');
    expect(task?.approvedBy).toBeNull();
  });

  it('escalates to needs_human with escalationReason auto_merge_failed when the PR closed without merging', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    // approvedBy set — this task was armed for auto-merge off a prior human
    // Approve. A PR that closes unmerged and re-escalates to a human must
    // not let that stale approval survive to cover whatever a human decides
    // to do about the (now closed) PR next.
    await insertMergingTask(taskId, missionId, { approvedBy: 'u1' });

    mockOctokit.pulls.get.mockResolvedValue({ data: { state: 'closed', merged: false } });

    const result = await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('needs_human');
    expect(task?.escalationReason).toBe('auto_merge_failed');
    expect(task?.lastError).toMatch(/closed without merging/);
    expect(task?.approvedBy).toBeNull();
    expect(result.mergesEscalated).toBe(1);

    const events = await getLedgerEvents(taskId);
    const failed = events.find((e) => e.eventType === 'auto_merge.failed');
    expect(failed).toBeDefined();
    expect(failed?.payload).toMatchObject({ prNumber: 42, reason: 'pr_closed_unmerged' });
  });

  it('leaves the Task in merging when the PR is still open — legitimately waiting on checks', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertMergingTask(taskId, missionId);

    mockOctokit.pulls.get.mockResolvedValue({ data: { state: 'open', merged: false } });

    const result = await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('merging');
    expect(result.mergesCompleted).toBe(0);
    expect(result.mergesEscalated).toBe(0);

    const events = await getLedgerEvents(taskId);
    expect(events.find((e) => e.eventType === 'auto_merge.merged')).toBeUndefined();
    expect(events.find((e) => e.eventType === 'auto_merge.failed')).toBeUndefined();
  });

  it('completes the mission in the same tick once the sweep confirms the PR merged', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertMergingTask(taskId, missionId);

    mockOctokit.pulls.get.mockResolvedValue({ data: { state: 'closed', merged: true } });

    await runReconciler(noopLog);

    const mission = await getMission(missionId);
    expect(mission?.status).toBe('completed');
  });
});
