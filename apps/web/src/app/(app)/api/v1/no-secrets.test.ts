import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

/**
 * The cross-route guard for Finding 4: `missions.webhookSecret` — the HMAC
 * key authenticating inbound callbacks for a mission — must not appear in
 * ANY /api/v1 response body.
 *
 * Deliberately not written as "assert the DTO omits it" (dto.test.ts already
 * does that, one function call deep). This drives the real exported route
 * handlers and searches the raw response TEXT, so it catches the secret
 * arriving by any route: a handler that skips the DTO, a nested object that
 * happens to carry the row, a future endpoint that re-selects all columns.
 * The needle is a per-run random string, so a match cannot be coincidental.
 */

const DB_FILE = `/tmp/forge-v1-no-secrets-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const SECRET = `whsec_${randomUUID().replaceAll('-', '')}`;
const USER = 'secret_owner';

const mocks = vi.hoisted(() => ({ apiAuth: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ apiAuth: mocks.apiAuth }));

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');

let listMissions: typeof import('./missions/route').GET;
let createMission: typeof import('./missions/route').POST;
let getMissionRoute: typeof import('./missions/[missionId]/route').GET;
let planRoute: typeof import('./missions/[missionId]/plan/route').POST;
let startRoute: typeof import('./missions/[missionId]/start/route').POST;
let cancelRoute: typeof import('./missions/[missionId]/cancel/route').POST;
let retryRoute: typeof import('./missions/[missionId]/retry/route').POST;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ GET: listMissions, POST: createMission } = await import('./missions/route'));
  ({ GET: getMissionRoute } = await import('./missions/[missionId]/route'));
  ({ POST: planRoute } = await import('./missions/[missionId]/plan/route'));
  ({ POST: startRoute } = await import('./missions/[missionId]/start/route'));
  ({ POST: cancelRoute } = await import('./missions/[missionId]/cancel/route'));
  ({ POST: retryRoute } = await import('./missions/[missionId]/retry/route'));
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

async function seedMission(over: Record<string, unknown> = {}): Promise<string> {
  const id = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const now = new Date();
  await db.insert(schema.missions).values({
    id,
    userId: USER,
    name: 'Secret-bearing mission',
    goal: 'do the thing in {{repo}}',
    status: 'draft',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    targetRepos: ['acme/widgets'],
    // Every seeded mission carries the SAME needle, so a leak from any
    // endpoint fails, not just the one whose row a test happened to read.
    webhookSecret: SECRET,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  return id;
}

/** Fails loudly with the offending body, so the diagnosis is in the failure. */
async function expectNoSecret(label: string, res: Response) {
  const text = await res.text();
  expect(res.status, `${label} did not succeed: ${text}`).toBeLessThan(300);
  expect(
    text.includes(SECRET),
    `${label} leaked missions.webhookSecret in its response body: ${text}`,
  ).toBe(false);
  // Guards against the test passing because the response was empty or an
  // error envelope: it must genuinely be a mission-bearing success body.
  expect(text.length, `${label} returned a suspiciously empty body`).toBeGreaterThan(2);
}

describe('no /api/v1 response leaks missions.webhookSecret', () => {
  it('GET /api/v1/missions', async () => {
    await seedMission();
    authAs(USER);
    await expectNoSecret('GET /missions', await listMissions(new Request('http://x'), {}));
  });

  it('POST /api/v1/missions', async () => {
    authAs(USER);
    const res = await createMission(
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Fresh mission',
          goal: 'ship it',
          backend: 'managed-agents',
          agentId: 'agent_1',
        }),
      }),
      {},
    );
    // This mission's secret is minted by createMissionForUser rather than
    // seeded, so the shared needle cannot apply — read the row back and
    // assert on the value actually stored for it.
    const text = await res.text();
    expect(res.status).toBe(201);
    const created = JSON.parse(text) as { mission: { id: string } };
    const [stored] = await db
      .select()
      .from(schema.missions)
      .where(eq(schema.missions.id, created.mission.id));
    expect(stored?.webhookSecret).toBeTruthy();
    expect(
      text.includes(stored!.webhookSecret),
      `POST /missions leaked the webhookSecret it just minted: ${text}`,
    ).toBe(false);
  });

  it('GET /api/v1/missions/{id}', async () => {
    const id = await seedMission();
    authAs(USER);
    await expectNoSecret('GET /missions/{id}', await getMissionRoute(new Request('http://x'), params(id)));
  });

  it('POST /api/v1/missions/{id}/plan', async () => {
    const id = await seedMission({ status: 'draft' });
    authAs(USER);
    await expectNoSecret(
      'POST plan',
      await planRoute(new Request('http://x', { method: 'POST' }), params(id)),
    );
  });

  it('POST /api/v1/missions/{id}/start', async () => {
    const id = await seedMission({ status: 'planning' });
    authAs(USER);
    await expectNoSecret(
      'POST start',
      await startRoute(new Request('http://x', { method: 'POST' }), params(id)),
    );
  });

  it('POST /api/v1/missions/{id}/cancel', async () => {
    const id = await seedMission({ status: 'running' });
    authAs(USER);
    await expectNoSecret(
      'POST cancel',
      await cancelRoute(new Request('http://x', { method: 'POST' }), params(id)),
    );
  });

  it('POST /api/v1/missions/{id}/retry', async () => {
    const id = await seedMission({ status: 'completed' });
    authAs(USER);
    await expectNoSecret(
      'POST retry',
      await retryRoute(new Request('http://x', { method: 'POST' }), params(id)),
    );
  });
});
