import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// Point the real ./db module at a throwaway libSQL file BEFORE it is imported
// (mirrors the pattern used by apps/web/src/server/tick's DB-integration tests).
const DB_FILE = `/tmp/forge-chat-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({
  withAuth: vi.fn(),
  streamTextCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/with-auth', () => ({ withAuth: mocks.withAuth }));

// Only streamText is replaced (with a real partial mock, not a hand-rolled
// stub) — everything else from 'ai' (including isStepCount/convertToModelMessages)
// stays real. Capturing the call args gives direct access to the route's
// real `tools` object, whose execute() closures run against the real test DB.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (opts: Record<string, unknown>) => {
      mocks.streamTextCalls.push(opts);
      return { toUIMessageStreamResponse: () => new Response('ok') };
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
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../../../../packages/db/migrations'),
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
  mocks.streamTextCalls.length = 0;
  mocks.withAuth.mockReset();
});

function chatRequest(text = 'hello', headers: Record<string, string> = {}): Request {
  return new Request('http://x/api/chat', {
    method: 'POST',
    // The route rejects anything that cannot prove same-origin (#44), so a
    // legitimate request now carries these. Overridable per test.
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: JSON.stringify({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }],
    }),
  });
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

async function insertTask(id: string, missionId: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTools = any;

describe('POST /api/chat', () => {
  it('builds the streamText request with instructions (not system) and the full tool set', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_a', name: 'A', email: 'a@x.com' });

    await POST(chatRequest());

    expect(mocks.streamTextCalls).toHaveLength(1);
    const call = mocks.streamTextCalls[0]!;
    expect(call.instructions).toContain('Forge, an autonomous fleet orchestrator');
    expect(call.system).toBeUndefined();
    expect(Object.keys(call.tools as object)).toEqual([
      'create_mission',
      'get_mission',
      'list_missions',
      'list_repos',
      'cancel_mission',
    ]);
    expect(call.stopWhen).toBeDefined();
  });

  it('propagates an unauthenticated request without ever calling streamText', async () => {
    mocks.withAuth.mockRejectedValueOnce(new Error('not authenticated'));

    await expect(POST(chatRequest())).rejects.toThrow('not authenticated');
    expect(mocks.streamTextCalls).toHaveLength(0);
  });
});

describe('create_mission tool', () => {
  it('creates a mission, task, and ledger event transactionally when a repo is given', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_b', name: 'B', email: 'b@x.com' });
    await POST(chatRequest());
    const tools = mocks.streamTextCalls[0]!.tools as AnyTools;

    const result = await tools.create_mission.execute({ goal: 'bump lodash', repo: 'acme/widgets' });

    expect(result.status).toBe('dispatched');
    expect(result.repo).toBe('acme/widgets');

    const [mission] = await db
      .select()
      .from(schema.missions)
      .where(eq(schema.missions.id, result.missionId));
    expect(mission?.userId).toBe('user_b');
    expect(mission?.targetRepos).toEqual(['acme/widgets']);

    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, result.taskId));
    expect(task?.repo).toBe('acme/widgets');
    expect(task?.status).toBe('queued');

    const ledger = await db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.missionId, result.missionId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.eventType).toBe('mission.created_from_chat');
  });

  it('returns an error object (not a throw) when the user has no connected repos', async () => {
    mocks.withAuth.mockResolvedValueOnce({ id: 'user_c', name: 'C', email: 'c@x.com' });
    await POST(chatRequest());
    const tools = mocks.streamTextCalls[0]!.tools as AnyTools;

    const result = await tools.create_mission.execute({ goal: 'bump lodash' });

    expect(result).toEqual({ error: 'No connected repos. Visit /setup to connect GitHub repos.' });
  });
});

describe('cross-user data scoping', () => {
  it('get_mission does not return another user’s mission', async () => {
    await insertMission('msn_other_user', 'user_owner');

    mocks.withAuth.mockResolvedValueOnce({
      id: 'user_attacker',
      name: 'Attacker',
      email: 'atk@x.com',
    });
    await POST(chatRequest());
    const tools = mocks.streamTextCalls[0]!.tools as AnyTools;

    const result = await tools.get_mission.execute({ missionId: 'msn_other_user' });

    expect(result).toEqual({ error: 'Mission not found' });
  });

  it('list_missions only returns the authenticated user’s own missions', async () => {
    await insertMission('msn_scope_a', 'user_scope_owner');
    await insertMission('msn_scope_b', 'user_scope_other');

    mocks.withAuth.mockResolvedValueOnce({
      id: 'user_scope_owner',
      name: 'Owner',
      email: 'o@x.com',
    });
    await POST(chatRequest());
    const tools = mocks.streamTextCalls[0]!.tools as AnyTools;

    const result = await tools.list_missions.execute({});
    const ids = result.missions.map((m: { id: string }) => m.id);

    expect(ids).toContain('msn_scope_a');
    expect(ids).not.toContain('msn_scope_b');
  });
});

describe('cancel_mission tool', () => {
  it('refuses to cancel a mission owned by a different user', async () => {
    await insertMission('msn_cancel_other', 'user_cancel_owner', { status: 'running' });

    mocks.withAuth.mockResolvedValueOnce({
      id: 'user_cancel_attacker',
      name: 'Attacker',
      email: 'atk2@x.com',
    });
    await POST(chatRequest());
    const tools = mocks.streamTextCalls[0]!.tools as AnyTools;

    const result = await tools.cancel_mission.execute({ missionId: 'msn_cancel_other' });

    expect(result).toEqual({ error: 'Mission not found' });

    const [mission] = await db
      .select()
      .from(schema.missions)
      .where(eq(schema.missions.id, 'msn_cancel_other'));
    expect(mission?.status).toBe('running');
  });

  it('refuses to cancel a mission that is not running or paused', async () => {
    await insertMission('msn_cancel_completed', 'user_cancel_self', { status: 'completed' });

    mocks.withAuth.mockResolvedValueOnce({
      id: 'user_cancel_self',
      name: 'Self',
      email: 's@x.com',
    });
    await POST(chatRequest());
    const tools = mocks.streamTextCalls[0]!.tools as AnyTools;

    const result = await tools.cancel_mission.execute({ missionId: 'msn_cancel_completed' });

    expect(result.error).toContain('Cannot cancel mission in "completed" status');
  });

  it('cancels a running mission and abandons its in-flight tasks', async () => {
    await insertMission('msn_cancel_valid', 'user_cancel_valid', { status: 'running' });
    await insertTask('tsk_cancel_valid', 'msn_cancel_valid', { status: 'running' });

    mocks.withAuth.mockResolvedValueOnce({
      id: 'user_cancel_valid',
      name: 'Valid',
      email: 'v@x.com',
    });
    await POST(chatRequest());
    const tools = mocks.streamTextCalls[0]!.tools as AnyTools;

    const result = await tools.cancel_mission.execute({ missionId: 'msn_cancel_valid' });

    expect(result).toEqual({ cancelled: true, missionId: 'msn_cancel_valid' });

    const [mission] = await db
      .select()
      .from(schema.missions)
      .where(eq(schema.missions.id, 'msn_cancel_valid'));
    expect(mission?.status).toBe('cancelled');

    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'tsk_cancel_valid'));
    expect(task?.status).toBe('abandoned');
  });
});

describe('POST /api/chat — cross-site hardening (#44)', () => {
  // Route handlers are not covered by Next's Server Action origin check, so a
  // cross-site POST arrives with the session cookie attached. This route can
  // create missions and spend LLM budget, so a valid cookie is not enough.
  it('rejects a cross-site request before authenticating or calling the model', async () => {
    const res = await POST(chatRequest('hi', { 'sec-fetch-site': 'cross-site' }));

    expect(res.status).toBe(403);
    expect(mocks.withAuth).not.toHaveBeenCalled(); // no session lookup
    expect(mocks.streamTextCalls).toHaveLength(0); // no model spend
  });

  it('rejects a non-JSON content-type — the shape a cross-site form can send without a preflight', async () => {
    const res = await POST(
      chatRequest('hi', { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' }),
    );

    expect(res.status).toBe(403);
    expect(mocks.streamTextCalls).toHaveLength(0);
  });

  it('does not leak the reason to the caller', async () => {
    const res = await POST(chatRequest('hi', { 'sec-fetch-site': 'cross-site' }));
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });
});
