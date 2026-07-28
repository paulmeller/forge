import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-v1-cancel-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({
  apiAuth: vi.fn(),
  cancelMissionSpy: vi.fn(),
}));
vi.mock('@/lib/api-auth', () => ({ apiAuth: mocks.apiAuth }));

vi.mock('@/lib/mission-transitions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mission-transitions')>();
  return {
    ...actual,
    cancelMission: (...args: Parameters<typeof actual.cancelMission>) => {
      mocks.cancelMissionSpy(...args);
      return actual.cancelMission(...args);
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
  mocks.cancelMissionSpy.mockClear();
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

async function statusOf(missionId: string): Promise<string | undefined> {
  const [row] = await db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
  return row?.status;
}

describe('POST /api/v1/missions/[missionId]/cancel', () => {
  it('cancels the mission for its owner', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_1');

    authAs('owner_1');
    const res = await POST(new Request('http://x', { method: 'POST' }), params(missionId));
    expect(res.status).toBe(200);
    // Envelope: the mission is under `mission`, exactly as on retry/plan/get.
    expect((await res.json()).mission.id).toBe(missionId);
    expect(await statusOf(missionId)).toBe('cancelled');
  });

  it('404s for a mission owned by someone else, and never transitions it', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_2');

    authAs('attacker_1');
    const res = await POST(new Request('http://x', { method: 'POST' }), params(missionId));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    expect(await statusOf(missionId)).toBe('running');
    expect(mocks.cancelMissionSpy).not.toHaveBeenCalled();
  });

  it('404s for a nonexistent mission id, identically to a non-owned one', async () => {
    authAs('owner_1');
    const res = await POST(new Request('http://x', { method: 'POST' }), params('msn_does_not_exist'));
    expect(res.status).toBe(404);
    expect(mocks.cancelMissionSpy).not.toHaveBeenCalled();
  });

  it('409s when the mission is not cancellable', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_1', { status: 'completed' });

    authAs('owner_1');
    const res = await POST(new Request('http://x', { method: 'POST' }), params(missionId));
    expect(res.status).toBe(409);
    // MissionTransitionError's WRONG_STATUS is mapped, not forwarded: the
    // wire only ever carries the closed set from lib/api/errors.ts, and the
    // domain message is what keeps the specific cause legible.
    const body = await res.json();
    expect(body.error.code).toBe('invalid_state');
    expect(body.error.message).toMatch(/expected mission in/);
  });
});
