import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-proposals-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({ apiAuth: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ apiAuth: mocks.apiAuth }));

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let PATCH: typeof import('./route').PATCH;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ PATCH } = await import('./route'));
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

function params(proposalId: string) {
  return { params: Promise.resolve({ proposalId }) };
}

function patchRequest(decision: string) {
  return new Request('http://x', {
    method: 'PATCH',
    body: JSON.stringify({ decision }),
  });
}

async function insertProposalChain(ownerId: string) {
  const now = new Date();
  const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const retroId = `ret_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const proposalId = `prp_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  await db.insert(schema.missions).values({
    id: missionId,
    userId: ownerId,
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
  await db.insert(schema.retrospectives).values({
    id: retroId,
    missionId,
    status: 'completed',
    requestedBy: ownerId,
    createdAt: now,
  });
  await db.insert(schema.retrospectiveProposals).values({
    id: proposalId,
    retrospectiveId: retroId,
    type: 'memory_entry',
    status: 'pending',
    content: {
      scope: 'repo',
      scopeKey: 'acme/widgets',
      key: 'secret',
      value: "another user's proposal payload",
      confidence: 0.9,
      rationale: 'test fixture',
    },
    createdAt: now,
  });

  return proposalId;
}

async function proposalStatus(proposalId: string) {
  const [row] = await db
    .select()
    .from(schema.retrospectiveProposals)
    .where(eq(schema.retrospectiveProposals.id, proposalId));
  return row;
}

describe('PATCH /api/proposals/[proposalId]', () => {
  it('reviews the proposal for the mission owner', async () => {
    const proposalId = await insertProposalChain('owner_1');

    authAs('owner_1');
    const res = await PATCH(patchRequest('accepted'), params(proposalId));
    expect(res.status).toBe(200);
    expect((await proposalStatus(proposalId))?.status).toBe('accepted');
  });

  it('404s for a proposal whose mission belongs to someone else, and leaves it untouched', async () => {
    const proposalId = await insertProposalChain('owner_2');

    authAs('attacker_1');
    const res = await PATCH(patchRequest('accepted'), params(proposalId));
    expect(res.status).toBe(404);
    const row = await proposalStatus(proposalId);
    expect(row?.status).toBe('pending');
    expect(JSON.stringify(await res.json())).not.toContain("another user's proposal payload");
  });
});
