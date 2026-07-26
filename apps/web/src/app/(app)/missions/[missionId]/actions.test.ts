import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-mission-actions-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({
  withAuth: vi.fn(),
  pauseMissionSpy: vi.fn(),
}));
vi.mock('@/lib/with-auth', () => ({ withAuth: mocks.withAuth }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/mission-transitions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mission-transitions')>();
  return {
    ...actual,
    pauseMission: (...args: Parameters<typeof actual.pauseMission>) => {
      mocks.pauseMissionSpy(...args);
      return actual.pauseMission(...args);
    },
  };
});

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let missionAction: typeof import('./actions').missionAction;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ missionAction } = await import('./actions'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(() => {
  mocks.withAuth.mockReset();
  mocks.pauseMissionSpy.mockClear();
});

function form(missionId: string, op: string): FormData {
  const fd = new FormData();
  fd.set('missionId', missionId);
  fd.set('op', op);
  return fd;
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

describe('missionAction', () => {
  it('pauses the mission for its owner', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_1');
    mocks.withAuth.mockResolvedValueOnce({ id: 'owner_1', name: 'Owner', email: 'o@x.com' });

    const result = await missionAction({}, form(missionId, 'pause'));
    expect(result).toEqual({});
    expect(await statusOf(missionId)).toBe('paused');
  });

  it('refuses to pause a mission owned by someone else, and never calls the transition', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_2');
    mocks.withAuth.mockResolvedValueOnce({ id: 'attacker_1', name: 'Attacker', email: 'a@x.com' });

    const result = await missionAction({}, form(missionId, 'pause'));
    expect(result.error).toBeDefined();
    expect(await statusOf(missionId)).toBe('running');
    expect(mocks.pauseMissionSpy).not.toHaveBeenCalled();
  });

  it('never reaches the transition for an unauthenticated caller (withAuth throws/redirects first)', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_3');
    // withAuth() calls redirect('/login') for no session, which throws a
    // special NEXT_REDIRECT error outside of Next's request scope — model
    // that here the same way src/app/(app)/api/chat/route.test.ts does.
    mocks.withAuth.mockRejectedValueOnce(new Error('NEXT_REDIRECT'));

    await expect(missionAction({}, form(missionId, 'pause'))).rejects.toThrow('NEXT_REDIRECT');
    expect(await statusOf(missionId)).toBe('running');
    expect(mocks.pauseMissionSpy).not.toHaveBeenCalled();
  });
});
