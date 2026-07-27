import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

import { MISSION_TERMINAL_TASK_STATUSES, DEPENDENCY_FAILED_STATUSES } from './reconciler';

describe('MISSION_TERMINAL_TASK_STATUSES', () => {
  it('includes merged as terminal', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toContain('merged');
  });

  it('includes needs_human as terminal (human takes over)', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toContain('needs_human');
  });

  it('includes abandoned as terminal', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toContain('abandoned');
  });

  it('includes failed as terminal', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toContain('failed');
  });

  it('excludes active execution states', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('queued');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('dispatching');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('running');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('turn_ended');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('opening_pr');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('awaiting_ci');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('awaiting_ai_review');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('merging');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('ready_to_merge');
  });

  it('includes resolved as terminal (reproduce verdict recorded, no PR)', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toContain('resolved');
  });

  it('has exactly 5 terminal states', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toHaveLength(5);
  });
});

describe('DEPENDENCY_FAILED_STATUSES', () => {
  it('includes failed', () => {
    expect(DEPENDENCY_FAILED_STATUSES).toContain('failed');
  });

  it('includes abandoned', () => {
    expect(DEPENDENCY_FAILED_STATUSES).toContain('abandoned');
  });

  it('has exactly 2 statuses', () => {
    expect(DEPENDENCY_FAILED_STATUSES).toHaveLength(2);
  });
});

describe('runReconciler — standing mission exemption', () => {
  // Point the real ./db module at a throwaway libSQL file BEFORE it is
  // imported (mirrors apps/tick/src/reconciler.integration.test.ts).
  const DB_FILE = `/tmp/forge-recon-standing-${process.pid}.db`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
  process.env.DATABASE_URL = `file:${DB_FILE}`;
  process.env.GATE_STALL_MS = '999999999'; // don't let the stall sweep interfere

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

  async function insertMission(id: string, over: Record<string, unknown> = {}) {
    const now = new Date();
    await db.insert(schema.missions).values({
      id,
      userId: 'user_1',
      name: 'Test mission',
      goal: 'test',
      status: 'running',
      backend: 'managed-agents',
      agentId: 'agent_1',
      plannerStrategy: 'triage',
      webhookSecret: 'secret',
      createdAt: now,
      updatedAt: now,
      ...over,
    });
  }

  async function insertTerminalTask(id: string, missionId: string) {
    const now = new Date();
    await db.insert(schema.tasks).values({
      id,
      missionId,
      repo: 'acme/api',
      baseBranch: 'main',
      kind: 'fix',
      status: 'merged',
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
  }

  async function getMission(id: string) {
    const [row] = await db.select().from(schema.missions).where(eq(schema.missions.id, id)).limit(1);
    return row;
  }

  it('never completes a container (zero tasks by construction), while an issue leaf and a campaign with all-terminal tasks both complete in the same pass', async () => {
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const issueLeafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const campaignId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    // Container: workspaceRepo set, no issueRef, no parent, zero tasks.
    await insertMission(containerId, { workspaceRepo: 'acme/api', issueRef: null, parentMissionId: null });

    // Issue leaf: workspaceRepo set, issueRef set, parent = the container.
    await insertMission(issueLeafId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#1',
      parentMissionId: containerId,
    });
    await insertTerminalTask(`tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`, issueLeafId);

    await insertMission(campaignId, { workspaceRepo: null, issueRef: null, parentMissionId: null });
    await insertTerminalTask(`tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`, campaignId);

    await runReconciler(noopLog);

    expect((await getMission(containerId))!.status).toBe('running');
    expect((await getMission(issueLeafId))!.status).toBe('completed');
    expect((await getMission(campaignId))!.status).toBe('completed');
  });

  // GATE_STALL_MS is fixed to '999999999' for the whole describe block (see
  // top of file) so the stall sweep doesn't interfere with the completion
  // test above. This test needs the sweep to actually fire, so it overrides
  // the env var for its own duration only (env.GATE_STALL_MS is read live at
  // call time — see apps/web/src/lib/env.ts) and restores it afterwards.
  it('gate-stall sweep escalates a Task wedged in a gate state to needs_human with escalationReason gate_stall', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#99',
      parentMissionId: null,
    });

    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const staleAt = new Date(Date.now() - 60_000); // 60s ago
    await db.insert(schema.tasks).values({
      id: taskId,
      missionId,
      repo: 'acme/api',
      baseBranch: 'main',
      kind: 'standard',
      status: 'awaiting_verify',
      // Set as if this task had been approved on a previous cycle before
      // stalling here — a re-escalation to a human must not let that
      // approval ride along.
      approvedBy: 'u1',
      createdAt: staleAt,
      updatedAt: staleAt,
    });

    const prevGateStallMs = process.env.GATE_STALL_MS;
    process.env.GATE_STALL_MS = '10'; // 10ms — the task above is 60s stale
    try {
      await runReconciler(noopLog);
    } finally {
      process.env.GATE_STALL_MS = prevGateStallMs;
    }

    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
    expect(row!.status).toBe('needs_human');
    expect(row!.escalationReason).toBe('gate_stall');
    expect(row!.approvedBy).toBeNull();
  });
});

describe('mission terminality', () => {
  it('does not treat ready_to_merge as terminal — unmerged work keeps a mission open', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('ready_to_merge');
  });

  it('treats needs_human as terminal — the mission has done all it can alone', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toContain('needs_human');
  });
});
