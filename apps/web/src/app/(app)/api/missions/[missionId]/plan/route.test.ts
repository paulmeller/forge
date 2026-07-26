import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-plan-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({
  apiAuth: vi.fn(),
  runPlannerSpy: vi.fn(),
}));
vi.mock('@/lib/api-auth', () => ({ apiAuth: mocks.apiAuth }));

vi.mock('@/lib/planner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planner')>();
  return {
    ...actual,
    runPlanner: (...args: Parameters<typeof actual.runPlanner>) => {
      mocks.runPlannerSpy(...args);
      return actual.runPlanner(...args);
    },
  };
});

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let POST: typeof import('./route').POST;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ POST } = await import('./route'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(() => {
  mocks.apiAuth.mockReset();
  mocks.runPlannerSpy.mockClear();
});

function authAs(id: string) {
  mocks.apiAuth.mockResolvedValueOnce([{ id, name: id, email: `${id}@x.com` }, null]);
}

function params(missionId: string) {
  return { params: Promise.resolve({ missionId }) };
}

async function insertMission(id: string, userId: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id,
    userId,
    name: 'Test mission',
    goal: 'do the thing in {{repo}}',
    status: 'draft',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    targetRepos: ['acme/widgets'],
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function statusOf(missionId: string): Promise<string | undefined> {
  const [row] = await db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
  return row?.status;
}

async function taskCountFor(missionId: string): Promise<number> {
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.missionId, missionId));
  return rows.length;
}

describe('POST /api/missions/[missionId]/plan', () => {
  it('plans the mission (emits tasks) for its owner', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_1');

    authAs('owner_1');
    const res = await POST(new Request('http://x', { method: 'POST' }), params(missionId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskCount).toBe(1);
    expect(await statusOf(missionId)).toBe('planning');
    expect(await taskCountFor(missionId)).toBe(1);
  });

  it('404s for a mission owned by someone else, runs the planner against nothing, and creates no tasks', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_2');

    authAs('attacker_1');
    const res = await POST(new Request('http://x', { method: 'POST' }), params(missionId));
    expect(res.status).toBe(404);
    expect(await statusOf(missionId)).toBe('draft');
    expect(await taskCountFor(missionId)).toBe(0);
    expect(mocks.runPlannerSpy).not.toHaveBeenCalled();
  });

  it('404s for a nonexistent mission id, identically to a non-owned one', async () => {
    authAs('owner_1');
    const res = await POST(new Request('http://x', { method: 'POST' }), params('msn_does_not_exist'));
    expect(res.status).toBe(404);
    expect(mocks.runPlannerSpy).not.toHaveBeenCalled();
  });
});
