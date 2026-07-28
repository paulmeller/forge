import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-v1-retry-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({
  apiAuth: vi.fn(),
  retryMissionSpy: vi.fn(),
}));
vi.mock('@/lib/api-auth', () => ({ apiAuth: mocks.apiAuth }));

vi.mock('@/lib/mission-transitions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mission-transitions')>();
  return {
    ...actual,
    retryMission: (...args: Parameters<typeof actual.retryMission>) => {
      mocks.retryMissionSpy(...args);
      return actual.retryMission(...args);
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
    migrationsFolder: resolve(__dirname, '../../../../../../../../../../packages/db/migrations'),
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
  mocks.retryMissionSpy.mockClear();
});

function authAs(id: string) {
  mocks.apiAuth.mockResolvedValueOnce([{ id, name: id, email: `${id}@x.com` }, null]);
}

function params(missionId: string) {
  return { params: Promise.resolve({ missionId }) };
}

async function insertMissionWithFailedTask(missionId: string, userId: string) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id: missionId,
    userId,
    name: 'Test mission',
    goal: 'test',
    status: 'completed',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
  });
  const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await db.insert(schema.tasks).values({
    id: taskId,
    missionId,
    repo: 'acme/widgets',
    baseBranch: 'main',
    status: 'failed',
    createdAt: now,
    updatedAt: now,
  });
  return taskId;
}

async function statusOf(missionId: string): Promise<string | undefined> {
  const [row] = await db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
  return row?.status;
}

async function taskStatusOf(taskId: string): Promise<string | undefined> {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
  return row?.status;
}

describe('POST /api/v1/missions/[missionId]/retry', () => {
  it('retries the mission (resets failed tasks) for its owner', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = await insertMissionWithFailedTask(missionId, 'owner_1');

    authAs('owner_1');
    const res = await POST(new Request('http://x', { method: 'POST' }), params(missionId));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Envelope: resource under `mission`, metadata as a sibling key.
    expect(body.mission.id).toBe(missionId);
    expect(body.retriedCount).toBe(1);
    expect(await statusOf(missionId)).toBe('running');
    expect(await taskStatusOf(taskId)).toBe('queued');
  });

  it('404s for a mission owned by someone else, and never retries it', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = await insertMissionWithFailedTask(missionId, 'owner_2');

    authAs('attacker_1');
    const res = await POST(new Request('http://x', { method: 'POST' }), params(missionId));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    expect(await statusOf(missionId)).toBe('completed');
    expect(await taskStatusOf(taskId)).toBe('failed');
    expect(mocks.retryMissionSpy).not.toHaveBeenCalled();
  });

  it('404s for a nonexistent mission id, identically to a non-owned one', async () => {
    authAs('owner_1');
    const res = await POST(new Request('http://x', { method: 'POST' }), params('msn_does_not_exist'));
    expect(res.status).toBe(404);
    expect(mocks.retryMissionSpy).not.toHaveBeenCalled();
  });
});
