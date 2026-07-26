import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

import type { Limits } from './guardrails';

// Point the real ./db module at a throwaway libSQL file BEFORE it is imported.
// (Mirrors budgets.integration.test.ts — see that file for why this has to be
// a dynamic import rather than a static one.)
const DB_FILE = `/tmp/forge-guardrails-int-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const cancelSession = vi.fn();
const getSession = vi.fn(
  async (): Promise<{ sessionId: string; status: import('./adapters').SessionLifecycle }> => ({
    sessionId: 'sess_leaf',
    status: 'terminated',
  }),
);
vi.mock('./adapters', () => ({
  getAdapter: () => ({ cancelSession, getSession }),
}));

// Dynamically imported after env is set.
let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let checkBreach: typeof import('./guardrails').checkBreach;
let resolveLimits: typeof import('./guardrails').resolveLimits;
let runGuardrails: typeof import('./guardrails').runGuardrails;

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ checkBreach, resolveLimits, runGuardrails } = await import('./guardrails'));
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
    status: 'running',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
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

describe('resolveLimits — precedence (mission → skill → env)', () => {
  const ENV = { TASK_MAX_TURNS: 30, TASK_MAX_TOKENS: 0, TASK_NO_PROGRESS_TOKENS: 200_000 };
  const noMissionOverride = { taskMaxTurns: null, taskMaxTokens: null, noProgressTokens: null };

  it('falls back to env when nothing is set', () => {
    expect(resolveLimits({ mission: noMissionOverride, policy: null, env: ENV })).toEqual({
      maxTurns: 30,
      maxTokens: 0,
      noProgressTokens: 200_000,
    });
  });

  it('skill policy overrides env', () => {
    const r = resolveLimits({
      mission: noMissionOverride,
      policy: { maxTurns: 12, noProgressTokens: 120_000 },
      env: ENV,
    });
    expect(r.maxTurns).toBe(12);
    expect(r.noProgressTokens).toBe(120_000);
    expect(r.maxTokens).toBe(0); // unset in policy → env
  });

  it('mission override beats skill policy and env', () => {
    const r = resolveLimits({
      mission: { taskMaxTurns: 5, taskMaxTokens: 500_000, noProgressTokens: 50_000 },
      policy: { maxTurns: 12, maxTokens: 999, noProgressTokens: 120_000 },
      env: ENV,
    });
    expect(r).toEqual({ maxTurns: 5, maxTokens: 500_000, noProgressTokens: 50_000 });
  });
});

describe('checkBreach — boundaries and priority', () => {
  const limits: Limits = { maxTurns: 30, maxTokens: 500_000, noProgressTokens: 200_000 };
  const base = { turnCount: 0, costTokens: 0, costTokensAtProgress: 0 };

  it('returns null when under every limit', () => {
    expect(
      checkBreach({ turnCount: 29, costTokens: 100, costTokensAtProgress: 0 }, limits),
    ).toBeNull();
  });

  it('turn cap fires exactly at >= maxTurns', () => {
    expect(checkBreach({ ...base, turnCount: 29 }, limits)).toBeNull();
    expect(checkBreach({ ...base, turnCount: 30 }, limits)).toBe('max_turns');
  });

  it('token cap fires exactly at >= maxTokens', () => {
    // Hold no-progress harmless by keeping the progress baseline close to spend.
    expect(
      checkBreach({ turnCount: 0, costTokens: 499_999, costTokensAtProgress: 450_000 }, limits),
    ).toBeNull();
    expect(
      checkBreach({ turnCount: 0, costTokens: 500_000, costTokensAtProgress: 450_000 }, limits),
    ).toBe('task_token_cap');
  });

  it('no-progress fires on tokens since last progress', () => {
    expect(
      checkBreach({ ...base, costTokens: 199_999, costTokensAtProgress: 0 }, limits),
    ).toBeNull();
    expect(checkBreach({ ...base, costTokens: 200_000, costTokensAtProgress: 0 }, limits)).toBe(
      'no_progress',
    );
    // baseline offset is respected
    expect(
      checkBreach({ ...base, costTokens: 350_000, costTokensAtProgress: 200_000 }, limits),
    ).toBeNull();
  });

  it('priority: turn cap wins when multiple limits breach', () => {
    expect(
      checkBreach({ turnCount: 30, costTokens: 600_000, costTokensAtProgress: 0 }, limits),
    ).toBe('max_turns');
  });

  it('priority: token cap beats no-progress', () => {
    expect(
      checkBreach({ turnCount: 0, costTokens: 600_000, costTokensAtProgress: 0 }, limits),
    ).toBe('task_token_cap');
  });

  it('a 0 (unbounded) limit never breaches', () => {
    const unbounded: Limits = { maxTurns: 0, maxTokens: 0, noProgressTokens: 0 };
    expect(
      checkBreach({ turnCount: 9999, costTokens: 9_999_999, costTokensAtProgress: 0 }, unbounded),
    ).toBeNull();
  });
});

describe('runGuardrails — cancel verification', () => {
  it('still marks the task failed when cancel silently missed (getSession reports it still running)', async () => {
    await insertMission('grd_mission_running', { taskMaxTurns: 2 });
    await insertTask('grd_t_running', 'grd_mission_running', {
      status: 'running',
      sessionId: 'sess_grd_running',
      turnCount: 5,
    });

    // cancelSession "succeeds" (no throw) but the session never actually stopped —
    // the exact silent-miss scenario verifyCancelled exists to catch.
    getSession.mockResolvedValueOnce({ sessionId: 'sess_grd_running', status: 'running' as const });

    const result = await runGuardrails(noopLog);
    expect(result.halted).toBe(1);
    expect(result.byReason.max_turns).toBe(1);

    const task = await getTask('grd_t_running');
    expect(task?.status).toBe('failed');
    expect(task?.haltReason).toBe('max_turns');

    const unverifiedEvents = await ledgerEventsFor(
      'grd_mission_running',
      'guardrails.cancel_unverified',
    );
    expect(unverifiedEvents).toHaveLength(1);
  });

  it('still marks the task failed when the post-cancel status read throws', async () => {
    await insertMission('grd_mission_reject', { taskMaxTurns: 2 });
    await insertTask('grd_t_reject', 'grd_mission_reject', {
      status: 'running',
      sessionId: 'sess_grd_reject',
      turnCount: 5,
    });

    getSession.mockRejectedValueOnce(new Error('backend unreachable'));

    const result = await runGuardrails(noopLog);
    expect(result.halted).toBe(1);
    expect(result.byReason.max_turns).toBe(1);

    const task = await getTask('grd_t_reject');
    expect(task?.status).toBe('failed');
    expect(task?.haltReason).toBe('max_turns');

    const unverifiedEvents = await ledgerEventsFor(
      'grd_mission_reject',
      'guardrails.cancel_unverified',
    );
    expect(unverifiedEvents).toHaveLength(1);
  });
});
