import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// Point the real ./db module at a throwaway libSQL file BEFORE it is imported.
const DB_FILE = `/tmp/forge-budgets-int-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const cancelSession = vi.fn();
// managed-agents' cancelSession sends user.interrupt, which drains the session
// to idle (not terminated) — this is the real successful-cancel shape.
const getSession = vi.fn(
  async (): Promise<{ sessionId: string; status: import('./adapters').SessionLifecycle }> => ({
    sessionId: 'sess_leaf',
    status: 'idle',
  }),
);
vi.mock('./adapters', () => ({
  getAdapter: () => ({ cancelSession, getSession }),
}));

// Dynamically imported after env is set.
let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let runBudgets: typeof import('./budgets').runBudgets;

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ runBudgets } = await import('./budgets'));
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

async function insertTask(id: string, missionId: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    kind: 'fix',
    status: 'merged',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function getMission(id: string) {
  const [row] = await db.select().from(schema.missions).where(eq(schema.missions.id, id)).limit(1);
  return row;
}

async function getTask(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return row;
}

/**
 * DB-level invariant check, independent of any one call site: a Task that is
 * not `needs_human` or `ready_to_merge` must never carry a non-null
 * `approvedBy` — an approval applies to work awaiting or cleared for merge,
 * nothing else. Scanning the whole table (rather than asserting per-field on
 * one seeded row) is what makes this durable against a *future* write path
 * into failed/abandoned/queued that forgets to clear the field — a
 * per-call-site test only ever proves the sites it was written for.
 */
async function approvedByInvariantViolations() {
  return db
    .select({ id: schema.tasks.id, status: schema.tasks.status, approvedBy: schema.tasks.approvedBy })
    .from(schema.tasks)
    .where(
      and(
        isNotNull(schema.tasks.approvedBy),
        notInArray(schema.tasks.status, ['needs_human', 'ready_to_merge']),
      ),
    );
}

async function ledgerEventsFor(missionId: string, eventType: string) {
  return db
    .select()
    .from(schema.ledgerEvents)
    .where(
      and(
        eq(schema.ledgerEvents.missionId, missionId),
        eq(schema.ledgerEvents.eventType, eventType),
      ),
    );
}

describe('runBudgets — container/leaf aggregation', () => {
  it('soft-pauses a container whose leaf tasks cross the threshold', async () => {
    await insertMission('bud_container_1', { budgetTokens: 1_000_000, budgetThresholdPct: 80 });
    await insertMission('bud_leaf_1', { parentMissionId: 'bud_container_1' });
    // Spend lives on the leaf's tasks (and a little on the container itself),
    // as after the container/leaf backfill.
    await insertTask('bud_t1', 'bud_leaf_1', { costTokens: 750_000 });
    await insertTask('bud_t2', 'bud_container_1', { costTokens: 100_000 });

    const result = await runBudgets(noopLog);

    const container = await getMission('bud_container_1');
    expect(container?.status).toBe('paused');
    expect(container?.spentTokens).toBe(850_000);
    expect(result.paused).toBeGreaterThanOrEqual(1);
    const events = await ledgerEventsFor('bud_container_1', 'budget.auto_paused');
    expect(events).toHaveLength(1);
    // The leaf itself (null budget) is never paused directly.
    const leaf = await getMission('bud_leaf_1');
    expect(leaf?.status).toBe('running');
  });

  it('hard stop pauses the container (not cancels) and reaches leaf tasks', async () => {
    await insertMission('bud_container_2', { budgetTokens: 1_000_000, budgetHardStopPct: 100 });
    await insertMission('bud_leaf_2', { parentMissionId: 'bud_container_2' });
    await insertTask('bud_t3', 'bud_leaf_2', {
      costTokens: 1_200_000,
      status: 'running',
      sessionId: 'sess_leaf',
    });
    await insertTask('bud_t4', 'bud_leaf_2', { costTokens: 0, status: 'queued' });

    const result = await runBudgets(noopLog);
    expect(result.hardStopped).toBe(1);

    const container = await getMission('bud_container_2');
    // Paused, not cancelled: cancelling would let the next "Work on it" mint a
    // fresh budget-less container, silently escaping the hard stop.
    expect(container?.status).toBe('paused');
    expect(container?.completedAt).toBeNull();

    expect(cancelSession).toHaveBeenCalledWith('sess_leaf', null);
    const inflightTask = await getTask('bud_t3');
    expect(inflightTask?.status).toBe('failed');
    expect(inflightTask?.haltReason).toBe('budget_hard_stop');
    const queuedTask = await getTask('bud_t4');
    expect(queuedTask?.status).toBe('abandoned');

    const events = await ledgerEventsFor('bud_container_2', 'budget.hard_stopped');
    expect(events).toHaveLength(1);
  });

  it('treats a session drained to idle as a verified cancel — the real successful-interrupt shape', async () => {
    await insertMission('bud_container_idle', { budgetTokens: 1_000_000, budgetHardStopPct: 100 });
    await insertTask('bud_t_idle', 'bud_container_idle', {
      costTokens: 1_200_000,
      status: 'running',
      sessionId: 'sess_idle',
    });

    // managed-agents cancelSession sends user.interrupt, which drains to idle —
    // this must NOT be reported as unverified.
    getSession.mockResolvedValueOnce({ sessionId: 'sess_idle', status: 'idle' as const });

    const result = await runBudgets(noopLog);
    expect(result.hardStopped).toBe(1);

    const task = await getTask('bud_t_idle');
    expect(task?.status).toBe('failed');
    expect(task?.haltReason).toBe('budget_hard_stop');

    const unverifiedEvents = await ledgerEventsFor(
      'bud_container_idle',
      'budgets.hard_stop_cancel_unverified',
    );
    expect(unverifiedEvents).toHaveLength(0);
  });

  it('still marks the task failed when cancel silently missed (getSession reports it still running)', async () => {
    await insertMission('bud_container_running', { budgetTokens: 1_000_000, budgetHardStopPct: 100 });
    await insertTask('bud_t_running', 'bud_container_running', {
      costTokens: 1_200_000,
      status: 'running',
      sessionId: 'sess_running',
    });

    // cancelSession "succeeds" (no throw) but the session never actually stopped —
    // the exact silent-miss scenario verifyCancelled exists to catch.
    getSession.mockResolvedValueOnce({ sessionId: 'sess_running', status: 'running' as const });

    const result = await runBudgets(noopLog);
    expect(result.hardStopped).toBe(1);

    const task = await getTask('bud_t_running');
    expect(task?.status).toBe('failed');
    expect(task?.haltReason).toBe('budget_hard_stop');

    const unverifiedEvents = await ledgerEventsFor(
      'bud_container_running',
      'budgets.hard_stop_cancel_unverified',
    );
    expect(unverifiedEvents).toHaveLength(1);
  });

  it('still marks the task failed when the post-cancel status read throws', async () => {
    await insertMission('bud_container_reject', { budgetTokens: 1_000_000, budgetHardStopPct: 100 });
    await insertTask('bud_t_reject', 'bud_container_reject', {
      costTokens: 1_200_000,
      status: 'running',
      sessionId: 'sess_reject',
    });

    getSession.mockRejectedValueOnce(new Error('backend unreachable'));

    const result = await runBudgets(noopLog);
    expect(result.hardStopped).toBe(1);

    const task = await getTask('bud_t_reject');
    expect(task?.status).toBe('failed');
    expect(task?.haltReason).toBe('budget_hard_stop');

    const unverifiedEvents = await ledgerEventsFor(
      'bud_container_reject',
      'budgets.hard_stop_cancel_unverified',
    );
    expect(unverifiedEvents).toHaveLength(1);
  });

  it('still marks the task failed when the unverified-cancel ledger insert itself throws', async () => {
    await insertMission('bud_container_ledger_throw', {
      budgetTokens: 1_000_000,
      budgetHardStopPct: 100,
    });
    await insertTask('bud_t_ledger_throw', 'bud_container_ledger_throw', {
      costTokens: 1_200_000,
      status: 'running',
      sessionId: 'sess_ledger_throw',
    });

    // Force the unverified path (still running) AND make the ledger insert
    // that path performs throw — the failed-status update must still land.
    getSession.mockResolvedValueOnce({
      sessionId: 'sess_ledger_throw',
      status: 'running' as const,
    });
    const insertSpy = vi.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('ledger insert boom');
    });

    let result: Awaited<ReturnType<typeof runBudgets>>;
    try {
      result = await runBudgets(noopLog);
    } finally {
      insertSpy.mockRestore();
    }
    expect(result.hardStopped).toBe(1);

    const task = await getTask('bud_t_ledger_throw');
    expect(task?.status).toBe('failed');
    expect(task?.haltReason).toBe('budget_hard_stop');
  });

  it('does not re-fire the hard stop on the next tick when nothing is left to stop', async () => {
    const result = await runBudgets(noopLog);
    expect(result.hardStopped).toBe(0);
    const events = await ledgerEventsFor('bud_container_2', 'budget.hard_stopped');
    expect(events).toHaveLength(1);
  });

  it('hard stop clears approvedBy on a ready_to_merge task it fails', async () => {
    // INFLIGHT_STATUSES (what hardStop selects) includes ready_to_merge,
    // which can carry a human approvedBy from an earlier Approve — the
    // exact case the reviewer traced through dynamically.
    await insertMission('bud_container_rtm', { budgetTokens: 1_000_000, budgetHardStopPct: 100 });
    await insertTask('bud_t_rtm', 'bud_container_rtm', {
      costTokens: 1_200_000,
      status: 'ready_to_merge',
      sessionId: 'sess_rtm',
      approvedBy: 'u1',
    });

    const result = await runBudgets(noopLog);
    expect(result.hardStopped).toBe(1);

    const task = await getTask('bud_t_rtm');
    expect(task?.status).toBe('failed');
    expect(task?.approvedBy).toBeNull();
  });

  it('hard stop clears escalationReason on a needs_human task it fails', async () => {
    // Asserted as its own test, on its own field, against its own fixture —
    // conflating this with the approvedBy assertion above would make a
    // future mutant that drops only the escalationReason clear (or only the
    // approvedBy clear) indistinguishable from one that drops both.
    await insertMission('bud_container_nh', { budgetTokens: 1_000_000, budgetHardStopPct: 100 });
    await insertTask('bud_t_nh', 'bud_container_nh', {
      costTokens: 1_200_000,
      status: 'needs_human',
      sessionId: 'sess_nh',
      escalationReason: 'ai_review_rejected',
    });

    const result = await runBudgets(noopLog);
    expect(result.hardStopped).toBe(1);

    const task = await getTask('bud_t_nh');
    expect(task?.status).toBe('failed');
    expect(task?.escalationReason).toBeNull();
  });

  it('invariant: after a hard stop, no row holds approvedBy outside needs_human/ready_to_merge', async () => {
    await insertMission('bud_container_inv', { budgetTokens: 1_000_000, budgetHardStopPct: 100 });
    // One of each INFLIGHT_STATUSES shape that can carry approvedBy, all
    // over the hard-stop threshold so every one of them gets acted on.
    await insertTask('bud_t_inv_rtm', 'bud_container_inv', {
      costTokens: 1_200_000,
      status: 'ready_to_merge',
      sessionId: 'sess_inv_rtm',
      approvedBy: 'u1',
    });
    await insertTask('bud_t_inv_nh', 'bud_container_inv', {
      costTokens: 0,
      status: 'needs_human',
      sessionId: 'sess_inv_nh',
      approvedBy: 'u2',
      escalationReason: 'gate_stall',
    });
    await insertTask('bud_t_inv_merging', 'bud_container_inv', {
      costTokens: 0,
      status: 'merging',
      sessionId: 'sess_inv_merging',
      approvedBy: 'u3',
    });

    await runBudgets(noopLog);

    const violations = await approvedByInvariantViolations();
    expect(violations).toEqual([]);
  });
});
