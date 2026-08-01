import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { Task } from '@forge/db';

const DB_FILE = `/tmp/forge-mission-transitions-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let retryMission: typeof import('./mission-transitions').retryMission;
let cancelMission: typeof import('./mission-transitions').cancelMission;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ retryMission, cancelMission } = await import('./mission-transitions'));
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
    status: 'completed',
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
    kind: 'fix',
    status: 'abandoned',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function getTaskRow(id: string): Promise<Task> {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  if (!row) throw new Error(`no such task: ${id}`);
  return row as Task;
}

describe('retryMission', () => {
  it('resets failed/abandoned tasks to queued, clearing lastError/completedAt/sessionId/backendSessionRef', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, {
      status: 'failed',
      lastError: 'boom',
      completedAt: new Date(),
      sessionId: 'ses_old',
      backendSessionRef: 'ses_old',
    });

    await retryMission(missionId);

    const row = await getTaskRow(taskId);
    expect(row.status).toBe('queued');
    expect(row.lastError).toBeNull();
    expect(row.completedAt).toBeNull();
    expect(row.sessionId).toBeNull();
    expect(row.backendSessionRef).toBeNull();
  });

  it('clears a stale approvedBy and escalationReason when resetting a task to queued', async () => {
    // Reproduces the exploit precondition: a task approved once, then
    // bounced back to needs_human and dismissed to abandoned, still
    // carrying the old approvedBy/escalationReason. A retry produces
    // entirely new work (a different diff, a different PR) — neither the
    // old approval nor the old escalation reason describes it, and letting
    // approvedBy survive is exactly what lets a re-run sail through
    // requireHumanApproval on a PR nobody has reviewed.
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, {
      status: 'abandoned',
      approvedBy: 'u1',
      escalationReason: 'auto_merge_failed',
    });

    await retryMission(missionId);

    const row = await getTaskRow(taskId);
    expect(row.status).toBe('queued');
    expect(row.approvedBy).toBeNull();
    expect(row.escalationReason).toBeNull();
  });

  // I2: a retried task kept its previous PR's identity (prUrl/prNumber/
  // reviewDecision), so a `pull_request.closed{merged:true}` webhook for
  // that DEAD PR could still match this freshly re-queued task by URL alone
  // (taskByPrUrl in the webhook route matches on prUrl, and `queued` was
  // never in that route's TERMINAL_TASK_STATUSES) and settle it `merged` —
  // work that never ran, which also falsely satisfies dispatcher.ts's
  // depsSatisfied for anything depending on this task. Revert this clearing
  // and this test fails: prUrl (and prNumber/reviewDecision) survive the
  // retry.
  it('clears prUrl, prNumber and reviewDecision when resetting a task to queued', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, {
      status: 'failed',
      prUrl: 'https://github.com/acme/api/pull/42',
      prNumber: 42,
      reviewDecision: 'changes_requested',
    });

    await retryMission(missionId);

    const row = await getTaskRow(taskId);
    expect(row.status).toBe('queued');
    expect(row.prUrl).toBeNull();
    expect(row.prNumber).toBeNull();
    expect(row.reviewDecision).toBeNull();
  });

  it('does not touch tasks outside failed/abandoned', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, { status: 'running', approvedBy: 'u1' });

    await retryMission(missionId);

    const row = await getTaskRow(taskId);
    expect(row.status).toBe('running');
    expect(row.approvedBy).toBe('u1');
  });
});

describe('cancelMission', () => {
  // Issue #46: cancelMission moved the mission to `cancelled` but never
  // touched its tasks, so a queued/dispatching/running/turn_ended task kept
  // its live sessionId and the tick engine kept polling it after the
  // mission itself was done. Abandoning those tasks here is what the chat
  // route's cancel_mission tool already did — this closes the drift between
  // the two callers.
  it('abandons tasks left in a live (non-terminal, pre-merge) status', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, { status: 'running' });

    const liveTasks = (['queued', 'dispatching', 'running', 'turn_ended'] as const).map(
      (status) => ({ id: `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`, status }),
    );
    await Promise.all(
      liveTasks.map((t) => insertTask(t.id, missionId, { status: t.status, sessionId: 'ses_live' })),
    );

    await cancelMission(missionId);

    for (const t of liveTasks) {
      const row = await getTaskRow(t.id);
      expect(row.status).toBe('abandoned');
    }
  });

  it('leaves already-terminal tasks untouched', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, { status: 'running' });

    const terminalTasks = (['merged', 'resolved', 'abandoned', 'failed'] as const).map(
      (status) => ({ id: `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`, status }),
    );
    await Promise.all(terminalTasks.map((t) => insertTask(t.id, missionId, { status: t.status })));

    await cancelMission(missionId);

    for (const t of terminalTasks) {
      const row = await getTaskRow(t.id);
      expect(row.status).toBe(t.status);
    }
  });
});
