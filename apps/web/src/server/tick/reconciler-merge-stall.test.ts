import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// The merge-stall sweep (reconciler.ts step 1.8) rescues Tasks wedged in
// `ready_to_merge` or `merging` with no other exit:
//  - `ready_to_merge`: runAutoMerge's outer catch (auto-merge.ts) swallows a
//    persistently-erroring tryMerge and never moves the Task off
//    ready_to_merge; markBlocked similarly only ever touches `lastError`.
//  - `merging`: the merging sweep's (step 1.7, just above this one)
//    `pulls.get` failure path catches, logs, and continues with no attempt
//    counter — a revoked token or renamed repo wedges the Task here forever.
// Same DB-file + mocked-Octokit pattern as reconciler-merge.test.ts.
const mockOctokit = vi.hoisted(() => ({
  pulls: {
    get: vi.fn(),
  },
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

const DB_FILE = `/tmp/forge-recon-merge-stall-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;
process.env.GATE_STALL_MS = '999999999'; // don't let the gate-stall sweep interfere
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
  delete process.env.MERGE_STALL_MS;
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

async function getTask(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return row;
}

async function getLedgerEvents(taskId: string) {
  return db.select().from(schema.ledgerEvents).where(eq(schema.ledgerEvents.taskId, taskId));
}

describe('runReconciler — merge-stall sweep', () => {
  it('escalates a Task wedged in ready_to_merge past MERGE_STALL_MS to needs_human with escalationReason merge_stall, clearing approvedBy', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    const staleAt = new Date(Date.now() - 60_000); // 60s ago
    await db.insert(schema.tasks).values({
      id: taskId,
      missionId,
      repo: 'acme/api',
      baseBranch: 'main',
      status: 'ready_to_merge',
      prUrl: 'https://github.com/acme/api/pull/55',
      prNumber: 55,
      // Set as if a human approved this before auto-merge kept failing on
      // it — re-escalation to a human must not let that approval ride
      // along, same invariant as the gate-stall and merging sweeps.
      approvedBy: 'u1',
      createdAt: staleAt,
      updatedAt: staleAt,
    });

    process.env.MERGE_STALL_MS = '10'; // 10ms — the task above is 60s stale
    const result = await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('needs_human');
    expect(task?.escalationReason).toBe('merge_stall');
    expect(task?.approvedBy).toBeNull();
    expect(result.mergeStallsEscalated).toBe(1);

    const events = await getLedgerEvents(taskId);
    expect(events.find((e) => e.eventType === 'merge.stalled')).toBeDefined();
  });

  it('leaves a fresh ready_to_merge Task alone — not yet stale', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await db.insert(schema.tasks).values({
      id: taskId,
      missionId,
      repo: 'acme/api',
      baseBranch: 'main',
      status: 'ready_to_merge',
      prUrl: 'https://github.com/acme/api/pull/56',
      prNumber: 56,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    process.env.MERGE_STALL_MS = '999999999';
    const result = await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('ready_to_merge');
    expect(result.mergeStallsEscalated).toBe(0);
  });

  it('escalates a Task wedged in merging past MERGE_STALL_MS to needs_human with escalationReason merge_stall, even though the merging sweep itself left it alone this tick', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    const staleAt = new Date(Date.now() - 60_000); // 60s ago
    await db.insert(schema.tasks).values({
      id: taskId,
      missionId,
      repo: 'acme/api',
      baseBranch: 'main',
      status: 'merging',
      prUrl: 'https://github.com/acme/api/pull/57',
      prNumber: 57,
      createdAt: staleAt,
      updatedAt: staleAt,
    });

    // Simulates a revoked token / renamed repo: the merging sweep's
    // pulls.get call keeps failing, so its own catch path leaves the Task
    // exactly where it found it (no attempt counter, no escalation) —
    // that's the wedge this sweep exists to rescue.
    mockOctokit.pulls.get.mockRejectedValue(new Error('Bad credentials'));

    process.env.MERGE_STALL_MS = '10'; // 10ms — the task above is 60s stale
    const result = await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('needs_human');
    expect(task?.escalationReason).toBe('merge_stall');
    expect(result.mergeStallsEscalated).toBe(1);
  });

  it('leaves a merging Task alone whose PR is still genuinely open and not yet stale', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await db.insert(schema.tasks).values({
      id: taskId,
      missionId,
      repo: 'acme/api',
      baseBranch: 'main',
      status: 'merging',
      prUrl: 'https://github.com/acme/api/pull/58',
      prNumber: 58,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockOctokit.pulls.get.mockResolvedValue({ data: { state: 'open', merged: false } });

    process.env.MERGE_STALL_MS = '999999999';
    const result = await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('merging');
    expect(result.mergeStallsEscalated).toBe(0);
  });
});
