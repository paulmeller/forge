import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_FILE = `/tmp/forge-stream-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

vi.mock('@/lib/with-auth', () => ({
  withAuth: vi.fn(async () => ({ id: 'u1', name: 'User One', email: 'u1@forge.local' })),
}));

let GET: typeof import('./route').GET;
let client: { close: () => void };

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  client = dbMod.client as unknown as { close: () => void };
  // Route dir is 11 levels below repo root: stream → [taskId] → tasks →
  // [missionId] → missions → api → (app) → app → src → web → apps → root.
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../../../../packages/db/migrations'),
  });
  const schema = await import('@forge/db');
  const now = new Date();
  await dbMod.db.insert(schema.missions).values({
    id: 'm1', userId: 'u1', name: 'm', goal: 'g', status: 'running',
    backend: 'managed-agents', agentId: 'a1', plannerStrategy: 'triage',
    webhookSecret: 's', createdAt: now, updatedAt: now,
  });
  await dbMod.db.insert(schema.tasks).values({
    id: 'tsk_nosession', missionId: 'm1', repo: 'a/b', baseBranch: 'main',
    kind: 'fix', status: 'queued', createdAt: now, updatedAt: now,
  });
  await dbMod.db.insert(schema.tasks).values({
    id: 'tsk_live', missionId: 'm1', repo: 'a/b', baseBranch: 'main',
    kind: 'fix', status: 'running', sessionId: 'sess_1', createdAt: now, updatedAt: now,
  });
  // Owned by a different user — the caller (mocked as 'u1') must not be able
  // to stream this even though it has a live session, and it must 503 (not
  // 404) so ownership isn't distinguishable from "doesn't exist".
  await dbMod.db.insert(schema.missions).values({
    id: 'm2', userId: 'u2', name: 'm2', goal: 'g', status: 'running',
    backend: 'managed-agents', agentId: 'a1', plannerStrategy: 'triage',
    webhookSecret: 's', createdAt: now, updatedAt: now,
  });
  await dbMod.db.insert(schema.tasks).values({
    id: 'tsk_other_user', missionId: 'm2', repo: 'a/b', baseBranch: 'main',
    kind: 'fix', status: 'running', sessionId: 'sess_2', createdAt: now, updatedAt: now,
  });
  // Also owned by 'u1', so a request pairing it with tsk_live can only fail on
  // the mission-mismatch check — not on ownership.
  await dbMod.db.insert(schema.missions).values({
    id: 'm3', userId: 'u1', name: 'm3', goal: 'g', status: 'running',
    backend: 'managed-agents', agentId: 'a1', plannerStrategy: 'triage',
    webhookSecret: 's', createdAt: now, updatedAt: now,
  });
  ({ GET } = await import('./route'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

function params(taskId: string, missionId = 'm1') {
  return { params: Promise.resolve({ missionId, taskId }) };
}

describe('GET /api/missions/[missionId]/tasks/[taskId]/stream (in-process)', () => {
  it('503s (retryable) for an unknown task', async () => {
    const res = await GET(new Request('http://x'), params('tsk_missing'));
    expect(res.status).toBe(503);
  });

  it('503s (retryable) for a task with no session yet', async () => {
    const res = await GET(new Request('http://x'), params('tsk_nosession'));
    expect(res.status).toBe(503);
  });

  it('503s (not 404, not 200) for a live task owned by another user', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // Paired with its own mission so ownership is the only thing that can
    // reject it — otherwise the mismatch check would mask a lost user scope.
    const res = await GET(new Request('http://x'), params('tsk_other_user', 'm2'));
    expect(res.status).toBe(503);
    // Ownership must be enforced before the upstream proxy fetch ever fires.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('503s when the task is real and owned but belongs to a different mission', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await GET(new Request('http://x'), params('tsk_live', 'm3'));
    expect(res.status).toBe(503);
    // The URL must describe the task it serves: a mission the caller owns is
    // still the wrong mission, and must not proxy tsk_live's session.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('relays the engine stream with the managed-agents beta header', async () => {
    const upstream = new Response(new ReadableStream(), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(upstream);
    const res = await GET(new Request('http://x'), params('tsk_live'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/v1/sessions/sess_1/events/stream');
    expect((init?.headers as Record<string, string>)['anthropic-beta']).toBe(
      'managed-agents-2026-04-01',
    );
    fetchSpy.mockRestore();
  });

  it('502s when the upstream fetch rejects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('down'));
    const res = await GET(new Request('http://x'), params('tsk_live'));
    expect(res.status).toBe(502);
    fetchSpy.mockRestore();
  });
});
