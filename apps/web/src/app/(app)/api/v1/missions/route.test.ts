import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-v1-missions-route-${process.pid}.db`;
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
let POST: typeof import('./route').POST;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../packages/db/migrations'),
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
});

function authAs(id: string) {
  mocks.apiAuth.mockResolvedValueOnce([{ id, name: id, email: `${id}@x.com` }, null]);
}

async function seedMission(id: string, userId: string, over: Record<string, unknown> = {}) {
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
    workspaceRepo: null,
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

/** Grants `userId` access to `repo` the same way a real Setup installation does. */
async function grantRepoAccess(userId: string, repo: string) {
  const now = new Date();
  const installationRowId = `ghi_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await db.insert(schema.githubInstallations).values({
    id: installationRowId,
    userId,
    installationId: Math.floor(Math.random() * 1_000_000),
    accountLogin: repo.split('/')[0] ?? 'acme',
    accountType: 'Organization',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubInstallationRepos).values({
    id: `ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    installationId: installationRowId,
    repo,
    createdAt: now,
  });
}

describe('GET /api/v1/missions', () => {
  it('only lists missions owned by the caller', async () => {
    const mine = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const theirs = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await seedMission(mine, 'u1');
    await seedMission(theirs, 'someone_else');

    authAs('u1');
    const res = await GET(new Request('http://x'), {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.missions.map((m: { id: string }) => m.id)).toEqual([mine]);
  });

  it('honours the ?status= query filter declared in the schema registry', async () => {
    const running = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const cancelled = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const userId = `u_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await seedMission(running, userId, { status: 'running' });
    await seedMission(cancelled, userId, { status: 'cancelled' });

    authAs(userId);
    const res = await GET(new Request('http://x?status=cancelled'), {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.missions.map((m: { id: string }) => m.id)).toEqual([cancelled]);
  });

  it('400s on an unrecognised ?status= value rather than silently ignoring it', async () => {
    authAs('u1');
    const res = await GET(new Request('http://x?status=not-a-real-status'), {});
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_request');
  });
});

describe('POST /api/v1/missions', () => {
  it('creates a mission owned by the caller', async () => {
    authAs('u1');
    const res = await POST(
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify({
          name: 'My mission',
          goal: 'ship the thing',
          backend: 'managed-agents',
          agentId: 'agent_1',
        }),
      }),
      {},
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mission.userId).toBe('u1');
    expect(body.mission.name).toBe('My mission');
  });

  it('400s on invalid JSON body', async () => {
    authAs('u1');
    const res = await POST(new Request('http://x', { method: 'POST', body: '{not json' }), {});
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_request');
  });

  it('400s on a body that fails schema validation', async () => {
    authAs('u1');
    const res = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ name: '' }) }),
      {},
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_request');
  });

  it('403s and creates nothing when a targetRepo is inaccessible to the caller', async () => {
    const userId = `u_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await grantRepoAccess(userId, 'a/b');
    // Deliberately no access granted to c/d.
    authAs(userId);

    const before = (await db.select().from(schema.missions)).length;
    const res = await POST(
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify({
          name: 'My mission',
          goal: 'ship the thing',
          backend: 'managed-agents',
          agentId: 'agent_1',
          targetRepos: ['a/b', 'c/d'],
        }),
      }),
      {},
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    const after = (await db.select().from(schema.missions)).length;
    expect(after).toBe(before);
  });
});
