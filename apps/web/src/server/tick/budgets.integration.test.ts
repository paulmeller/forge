import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// Point the real ./db module at a throwaway libSQL file BEFORE it is imported.
const DB_FILE = `/tmp/forge-budgets-int-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const cancelSession = vi.fn();
const getSession = vi.fn(async () => ({ sessionId: 'sess_leaf', status: 'terminated' as const }));
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

  it('does not re-fire the hard stop on the next tick when nothing is left to stop', async () => {
    const result = await runBudgets(noopLog);
    expect(result.hardStopped).toBe(0);
    const events = await ledgerEventsFor('bud_container_2', 'budget.hard_stopped');
    expect(events).toHaveLength(1);
  });
});
