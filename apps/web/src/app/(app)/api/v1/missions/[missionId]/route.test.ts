import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-v1-mission-get-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({ apiAuth: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ apiAuth: mocks.apiAuth }));

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let GET: typeof import('./route').GET;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ GET } = await import('./route'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(() => {
  mocks.apiAuth.mockReset();
});

function authAs(id: string) {
  mocks.apiAuth.mockResolvedValueOnce([{ id, name: id, email: `${id}@x.com` }, null]);
}

function params(missionId: string) {
  return { params: Promise.resolve({ missionId }) };
}

async function seedMission(id: string, userId: string) {
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
  });
}

describe('GET /api/v1/missions/[missionId]', () => {
  it('404s a mission owned by another user, without leaking that it exists', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await seedMission(missionId, 'someone_else');

    authAs('attacker_1');
    const res = await GET(new Request('http://x'), params(missionId));
    expect(res.status).toBe(404);
    const body = await res.json();
    // Identical to a genuinely missing id — existence must not be observable.
    expect(body.error.code).toBe('not_found');
  });

  it('404s for a nonexistent mission id, identically to a non-owned one', async () => {
    authAs('owner_1');
    const res = await GET(new Request('http://x'), params('msn_does_not_exist'));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('returns a mission the caller owns', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await seedMission(missionId, 'u1');

    authAs('u1');
    const res = await GET(new Request('http://x'), params(missionId));
    expect(res.status).toBe(200);
    expect((await res.json()).mission.id).toBe(missionId);
  });
});
