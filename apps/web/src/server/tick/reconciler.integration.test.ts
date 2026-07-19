import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// Point the real ./db module at a throwaway libSQL file BEFORE it is imported.
const DB_FILE = `/tmp/forge-recon-int-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;
process.env.GATE_STALL_MS = '999999999'; // don't let the stall sweep interfere

// Dynamically imported after env is set.
let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let runReconciler: typeof import('./reconciler').runReconciler;

const noopLog = { info: () => {}, warn: () => {} };

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ runReconciler } = await import('./reconciler'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

let missionId: string;

beforeEach(async () => {
  // Fresh mission per test; cascade delete clears its tasks + ledger.
  await db.delete(schema.missions);
  missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const now = new Date();
  await db.insert(schema.missions).values({
    id: missionId,
    userId: 'user_1',
    name: 'Triage',
    goal: 'triage',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'triage',
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
  });
});

async function insertReproduce(id: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'vercel/ai',
    baseBranch: 'main',
    kind: 'reproduce',
    issueRef: 'vercel/ai#1',
    status: 'turn_ended',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function insertFix(id: string, dependsOn: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'vercel/ai',
    baseBranch: 'main',
    kind: 'fix',
    issueRef: 'vercel/ai#1',
    dependsOnIds: [dependsOn],
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function insertVerdictMessage(taskId: string, verdictJson: string) {
  await db.insert(schema.ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    missionId,
    taskId,
    eventType: 'agent.message',
    payload: { content: [{ type: 'text', text: verdictJson }] },
    createdAt: new Date(),
  });
}

async function getTask(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return row;
}

describe('runReconciler — triage gate (integration)', () => {
  it('settles a reproduce Task to resolved with the parsed positive verdict', async () => {
    await insertReproduce('tsk_rep');
    await insertVerdictMessage(
      'tsk_rep',
      '```forge-verdict\n{"reproduced": true, "summary": "empty content", "branch": "forge/triage-1"}\n```',
    );

    const res = await runReconciler(noopLog);

    const rep = await getTask('tsk_rep');
    expect(rep!.status).toBe('resolved');
    expect(rep!.verdict).toMatchObject({ reproduced: true, branch: 'forge/triage-1' });
    expect(res.reproduceResolved).toBe(1);
  });

  it('leaves the fix queued when the verdict is positive (dispatcher unblocks it later)', async () => {
    await insertReproduce('tsk_rep');
    await insertFix('tsk_fix', 'tsk_rep');
    await insertVerdictMessage(
      'tsk_rep',
      '```forge-verdict\n{"reproduced": true, "summary": "x"}\n```',
    );

    await runReconciler(noopLog);

    expect((await getTask('tsk_rep'))!.status).toBe('resolved');
    expect((await getTask('tsk_fix'))!.status).toBe('queued');
  });

  it('abandons the fix in the same tick when the verdict is negative', async () => {
    await insertReproduce('tsk_rep');
    await insertFix('tsk_fix', 'tsk_rep');
    await insertVerdictMessage(
      'tsk_rep',
      '```forge-verdict\n{"reproduced": false, "summary": "could not reproduce"}\n```',
    );

    const res = await runReconciler(noopLog);

    expect((await getTask('tsk_rep'))!.verdict).toMatchObject({ reproduced: false });
    const fix = await getTask('tsk_fix');
    expect(fix!.status).toBe('abandoned');
    expect(fix!.lastError).toBe('bug did not reproduce');
    expect(res.fixesGated).toBe(1);
  });

  it('abandons a reproduce Task that emitted no parseable verdict', async () => {
    await insertReproduce('tsk_rep');
    await insertVerdictMessage('tsk_rep', 'I looked into it but never printed a verdict block.');

    await runReconciler(noopLog);

    const rep = await getTask('tsk_rep');
    expect(rep!.status).toBe('abandoned');
    expect(rep!.lastError).toBe('reproduce agent emitted no verdict');
  });

  it('cascade-fails the fix when the reproduce Task itself failed', async () => {
    await insertReproduce('tsk_rep', { status: 'failed' });
    await insertFix('tsk_fix', 'tsk_rep');

    await runReconciler(noopLog);

    expect((await getTask('tsk_fix'))!.status).toBe('failed');
  });
});
