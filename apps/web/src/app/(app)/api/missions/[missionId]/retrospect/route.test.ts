import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-retrospect-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({
  apiAuth: vi.fn(),
  getRetrospectiveForMissionSpy: vi.fn(),
}));
vi.mock('@/lib/api-auth', () => ({ apiAuth: mocks.apiAuth }));

// Partial mock: real behaviour, but every call to getRetrospectiveForMission
// is recorded — the negative-control test asserts it was never reached for
// a non-owned mission id (ownership must be checked before this runs).
vi.mock('@/lib/retrospectives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/retrospectives')>();
  return {
    ...actual,
    getRetrospectiveForMission: (...args: Parameters<typeof actual.getRetrospectiveForMission>) => {
      mocks.getRetrospectiveForMissionSpy(...args);
      return actual.getRetrospectiveForMission(...args);
    },
  };
});

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let GET: typeof import('./route').GET;
let POST: typeof import('./route').POST;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ GET, POST } = await import('./route'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(() => {
  mocks.apiAuth.mockReset();
  mocks.getRetrospectiveForMissionSpy.mockClear();
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

async function insertRetro(id: string, missionId: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.retrospectives).values({
    id,
    missionId,
    status: 'completed',
    analysis: 'Secret narrative about this mission that a victim did not consent to share.',
    requestedBy: 'owner',
    createdAt: now,
    ...over,
  });
}

describe('GET /api/missions/[missionId]/retrospect', () => {
  it('returns the retrospective and proposals to the owner', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const retroId = `ret_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_1');
    await insertRetro(retroId, missionId);

    authAs('owner_1');
    const res = await GET(new Request('http://x'), params(missionId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retrospective.id).toBe(retroId);
    expect(body.retrospective.analysis).toContain('Secret narrative');
  });

  it('404s for a mission owned by someone else, and never reads the retrospective', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const retroId = `ret_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_2');
    await insertRetro(retroId, missionId);

    authAs('attacker_1');
    const res = await GET(new Request('http://x'), params(missionId));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('Secret narrative');
    // The ownership gate must short-circuit before the retrospective (and
    // its narrative analysis) is ever fetched.
    expect(mocks.getRetrospectiveForMissionSpy).not.toHaveBeenCalled();
  });

  it('404s for a nonexistent mission id, identically to a non-owned one', async () => {
    authAs('owner_1');
    const res = await GET(new Request('http://x'), params('msn_does_not_exist'));
    expect(res.status).toBe(404);
    expect(mocks.getRetrospectiveForMissionSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/missions/[missionId]/retrospect', () => {
  it('creates a retrospective for the owner', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_3');

    authAs('owner_3');
    const res = await POST(new Request('http://x', { method: 'POST' }), params(missionId));
    expect(res.status).toBe(201);

    const rows = await db
      .select()
      .from(schema.retrospectives)
      .where(eq(schema.retrospectives.missionId, missionId));
    expect(rows).toHaveLength(1);
  });

  it('404s for a mission owned by someone else, and creates no retrospective row', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, 'owner_4');

    authAs('attacker_2');
    const res = await POST(new Request('http://x', { method: 'POST' }), params(missionId));
    expect(res.status).toBe(404);

    const rows = await db
      .select()
      .from(schema.retrospectives)
      .where(eq(schema.retrospectives.missionId, missionId));
    expect(rows).toHaveLength(0);
  });
});
