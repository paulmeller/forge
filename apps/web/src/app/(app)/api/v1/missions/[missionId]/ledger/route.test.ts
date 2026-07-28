import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-v1-mission-ledger-route-${process.pid}.db`;
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
    migrationsFolder: resolve(__dirname, '../../../../../../../../../../packages/db/migrations'),
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

async function seedLedgerEvent(
  missionId: string,
  id: string,
  eventType: string,
  opts: { sourceEventId?: string; createdAt?: Date } = {},
): Promise<void> {
  await db.insert(schema.ledgerEvents).values({
    id,
    missionId,
    eventType,
    payload: { note: 'test' },
    sourceEventId: opts.sourceEventId,
    createdAt: opts.createdAt ?? new Date(),
  });
}

describe('GET /api/v1/missions/[missionId]/ledger', () => {
  it('returns a mission ledger the caller owns', async () => {
    await seedMission('m_mine', 'u1');
    await seedLedgerEvent('m_mine', 'evt1', 'mission.started');
    authAs('u1');

    const res = await GET(new Request('http://x'), params('m_mine'));

    expect(res.status).toBe(200);
    expect((await res.json()).events[0].eventType).toBe('mission.started');
  });

  it("404s another user's ledger — the audit trail is not cross-readable", async () => {
    await seedMission('m_theirs', 'other');
    await seedLedgerEvent('m_theirs', 'evt2', 'mission.started');
    authAs('attacker_1');

    const res = await GET(new Request('http://x'), params('m_theirs'));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { events?: unknown[] };
    expect(body.events).toBeUndefined();
  });

  it('returns a backend-agnostic shape', async () => {
    await seedMission('m_shape', 'u1');
    await seedLedgerEvent('m_shape', 'evt3', 'agent.tool_use', { sourceEventId: 'sevt_1' });
    authAs('u1');

    const res = await GET(new Request('http://x'), params('m_shape'));
    const body = await res.json();

    expect(Object.keys(body.events[0]).sort()).toEqual(
      ['createdAt', 'eventType', 'id', 'missionId', 'payload', 'sourceEventId', 'taskId'].sort(),
    );
  });

  it('honours the limit query parameter cap', async () => {
    await seedMission('m_limit', 'u1');
    for (let i = 0; i < 5; i++) {
      await seedLedgerEvent('m_limit', `evt_limit_${i}`, 'mission.started', {
        createdAt: new Date(Date.now() + i * 1000),
      });
    }
    authAs('u1');

    const res = await GET(new Request('http://x?limit=2'), params('m_limit'));
    const body = (await res.json()) as { events: unknown[] };

    expect(body.events.length).toBe(2);
  });

  it("404s for a nonexistent mission id, identically to a non-owned one", async () => {
    authAs('u1');

    const res = await GET(new Request('http://x'), params('m_does_not_exist'));

    expect(res.status).toBe(404);
  });
});
