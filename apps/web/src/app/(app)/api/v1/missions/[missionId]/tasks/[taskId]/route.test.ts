import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { TaskStatus } from '@forge/db';

const DB_FILE = `/tmp/forge-v1-task-get-route-${process.pid}.db`;
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
    migrationsFolder: resolve(__dirname, '../../../../../../../../../../../packages/db/migrations'),
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

function params(missionId: string, taskId: string) {
  return { params: Promise.resolve({ missionId, taskId }) };
}

async function seedMission(id: string, userId: string): Promise<void> {
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

async function seedTask(missionId: string, id: string, status: TaskStatus): Promise<void> {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    kind: 'fix',
    status,
    createdAt: now,
    updatedAt: now,
  });
}

describe('GET /api/v1/missions/[missionId]/tasks/[taskId]', () => {
  it('gets an owned task', async () => {
    await seedMission('m_mine', 'owner_1');
    await seedTask('m_mine', 't1', 'running');
    authAs('owner_1');

    const res = await GET(new Request('http://x'), params('m_mine', 't1'));

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('t1');
  });

  it("404s for another user's task", async () => {
    await seedMission('m_theirs', 'owner_2');
    await seedTask('m_theirs', 't_theirs', 'running');
    authAs('attacker_1');

    const res = await GET(new Request('http://x'), params('m_theirs', 't_theirs'));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('404s when the taskId belongs to a different mission than the URL names', async () => {
    await seedMission('m_a', 'owner_1');
    await seedMission('m_b', 'owner_1');
    await seedTask('m_a', 't_in_a', 'running');
    authAs('owner_1');

    const res = await GET(new Request('http://x'), params('m_b', 't_in_a'));

    expect(res.status).toBe(404);
  });
});
