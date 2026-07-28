import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { TaskStatus } from '@forge/db';

const DB_FILE = `/tmp/forge-v1-task-ledger-route-${process.pid}.db`;
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
    migrationsFolder: resolve(
      __dirname,
      '../../../../../../../../../../../../packages/db/migrations',
    ),
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

async function seedLedgerEvent(
  missionId: string,
  taskId: string,
  id: string,
  eventType: string,
  opts: { sourceEventId?: string; createdAt?: Date } = {},
): Promise<void> {
  await db.insert(schema.ledgerEvents).values({
    id,
    missionId,
    taskId,
    eventType,
    payload: { note: 'test' },
    sourceEventId: opts.sourceEventId,
    createdAt: opts.createdAt ?? new Date(),
  });
}

describe('GET /api/v1/missions/[missionId]/tasks/[taskId]/ledger', () => {
  it('returns a task ledger the caller owns', async () => {
    await seedMission('m_mine', 'u1');
    await seedTask('m_mine', 't_mine', 'running');
    await seedLedgerEvent('m_mine', 't_mine', 'evt1', 'task.started');
    authAs('u1');

    const res = await GET(new Request('http://x'), params('m_mine', 't_mine'));

    expect(res.status).toBe(200);
    expect((await res.json()).events[0].eventType).toBe('task.started');
  });

  it("404s another user's task ledger — the audit trail is not cross-readable", async () => {
    await seedMission('m_theirs', 'other');
    await seedTask('m_theirs', 't_theirs', 'running');
    await seedLedgerEvent('m_theirs', 't_theirs', 'evt2', 'task.started');
    authAs('attacker_1');

    const res = await GET(new Request('http://x'), params('m_theirs', 't_theirs'));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { events?: unknown[] };
    expect(body.events).toBeUndefined();
  });

  it('404s when the taskId belongs to a different mission than the URL names', async () => {
    await seedMission('m_a', 'owner_1');
    await seedMission('m_b', 'owner_1');
    await seedTask('m_a', 't_in_a', 'running');
    await seedLedgerEvent('m_a', 't_in_a', 'evt_cross', 'task.started');
    authAs('owner_1');

    const res = await GET(new Request('http://x'), params('m_b', 't_in_a'));

    expect(res.status).toBe(404);
  });

  it('returns a backend-agnostic shape', async () => {
    await seedMission('m_shape', 'u1');
    await seedTask('m_shape', 't_shape', 'running');
    await seedLedgerEvent('m_shape', 't_shape', 'evt3', 'agent.tool_use', {
      sourceEventId: 'sevt_1',
    });
    authAs('u1');

    const res = await GET(new Request('http://x'), params('m_shape', 't_shape'));
    const body = await res.json();

    expect(Object.keys(body.events[0]).sort()).toEqual(
      ['createdAt', 'eventType', 'id', 'missionId', 'payload', 'sourceEventId', 'taskId'].sort(),
    );
  });

  it('honours the limit query parameter cap', async () => {
    await seedMission('m_limit', 'u1');
    await seedTask('m_limit', 't_limit', 'running');
    for (let i = 0; i < 5; i++) {
      await seedLedgerEvent('m_limit', 't_limit', `evt_limit_${i}`, 'task.started', {
        createdAt: new Date(Date.now() + i * 1000),
      });
    }
    authAs('u1');

    const res = await GET(new Request('http://x?limit=2'), params('m_limit', 't_limit'));
    const body = (await res.json()) as { events: unknown[] };

    expect(body.events.length).toBe(2);
  });

  it("404s for a nonexistent task id, identically to a non-owned one", async () => {
    await seedMission('m_get_missing', 'owner_1');
    authAs('owner_1');

    const res = await GET(new Request('http://x'), params('m_get_missing', 't_does_not_exist'));

    expect(res.status).toBe(404);
  });
});
