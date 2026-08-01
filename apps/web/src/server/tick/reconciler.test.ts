import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

import {
  MISSION_TERMINAL_TASK_STATUSES,
  DEPENDENCY_FAILED_STATUSES,
  missionTerminalStatusesFor,
} from './reconciler';

// Only the merging-sweep CAS test below ever drives a `merging` Task through
// the reconciler, so it's the only test that reaches `getOctokit().pulls.get`
// — every other test in this file has no armed Task and never touches
// GitHub at all. Mocked exactly like auto-merge.test.ts's Octokit mock.
const reconOctokitMocks = vi.hoisted(() => ({ pullsGet: vi.fn() }));
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => ({ pulls: { get: reconOctokitMocks.pullsGet } })),
}));

// resolveAutoMergePolicy (called via runReconciler's standing-mission check)
// now consults resolveRepoPolicy for the .forge/policy.yml gate (#40) before
// falling through to the column reads this file exercises. None of these
// tests are about that file, so it's mocked to "no file" — same idiom as
// auto-merge-policy.test.ts — keeping this suite off the network.
const mockResolveRepoPolicy = vi.hoisted(() => vi.fn(async () => ({ source: 'default', policy: {} })));
vi.mock('@/lib/repo-policy', () => ({ resolveRepoPolicy: mockResolveRepoPolicy }));

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

  // C1: before this fix, `ready_to_merge` was unconditionally excluded from
  // MISSION_TERMINAL_TASK_STATUSES, so a Mission whose only PR-eligible Task
  // sat in `ready_to_merge` with no auto-merge policy configured (the
  // overwhelming common case — nothing writes missions.autoMergePolicy
  // anywhere in the app) never completed. Revert missionTerminalStatusesFor
  // to always return the bare MISSION_TERMINAL_TASK_STATUSES and this test
  // fails: the mission stays 'running' forever.
  it('completes a mission whose only Task is ready_to_merge when the mission has no enabled auto-merge policy', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#7',
      parentMissionId: null,
      autoMergePolicy: null,
    });

    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const now = new Date();
    await db.insert(schema.tasks).values({
      id: taskId,
      missionId,
      repo: 'acme/api',
      baseBranch: 'main',
      kind: 'fix',
      status: 'ready_to_merge',
      prUrl: 'https://github.com/acme/api/pull/9',
      prNumber: 9,
      createdAt: now,
      updatedAt: now,
    });

    await runReconciler(noopLog);

    expect((await getMission(missionId))!.status).toBe('completed');
  });

  // Mirror of the test above with the opposite precondition: an ENABLED
  // auto-merge policy means runAutoMerge (and, once armed, the merging
  // sweep) are expected to resolve this Task soon — the mission must stay
  // open until they do, or it could complete out from under an in-flight
  // merge. Revert missionTerminalStatusesFor to unconditionally exclude
  // ready_to_merge (i.e. restore the old bare-list behaviour everywhere)
  // and this test still passes; revert it to unconditionally INCLUDE
  // ready_to_merge instead (over-correcting the fix above) and this test
  // fails: the mission would wrongly complete here too.
  it('does not complete a mission whose only Task is ready_to_merge when the mission has an enabled auto-merge policy', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#8',
      parentMissionId: null,
      autoMergePolicy: { enabled: true },
    });

    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const now = new Date();
    await db.insert(schema.tasks).values({
      id: taskId,
      missionId,
      repo: 'acme/api',
      baseBranch: 'main',
      kind: 'fix',
      status: 'ready_to_merge',
      prUrl: 'https://github.com/acme/api/pull/10',
      prNumber: 10,
      createdAt: now,
      updatedAt: now,
    });

    await runReconciler(noopLog);

    expect((await getMission(missionId))!.status).toBe('running');
  });

  // Both subsystems must agree about a leaf's policy: if the reconciler ever
  // went back to reading a Mission row's own `autoMergePolicy` column
  // instead of resolving through resolveAutoMergePolicy, an issue-leaf
  // (whose own column is null by construction) would wrongly be treated as
  // "nothing will merge this" even though its CONTAINER has auto-merge
  // enabled — completing the Mission out from under an in-flight
  // runAutoMerge/merging-sweep resolution. Mirrors the equivalent guarantee
  // on the auto-merge.ts side (auto-merge.integration.test.ts's "selects a
  // leaf Task when only the CONTAINER has auto-merge enabled").
  it('does not complete an issue-leaf mission whose only Task is ready_to_merge when the CONTAINER has an enabled auto-merge policy (the leaf itself has none)', async () => {
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(containerId, {
      workspaceRepo: 'acme/api',
      issueRef: null,
      parentMissionId: null,
      autoMergePolicy: { enabled: true },
    });
    await insertMission(leafId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#11',
      parentMissionId: containerId,
      autoMergePolicy: null,
    });

    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const now = new Date();
    await db.insert(schema.tasks).values({
      id: taskId,
      missionId: leafId,
      repo: 'acme/api',
      baseBranch: 'main',
      kind: 'fix',
      status: 'ready_to_merge',
      prUrl: 'https://github.com/acme/api/pull/11',
      prNumber: 11,
      createdAt: now,
      updatedAt: now,
    });

    await runReconciler(noopLog);

    expect((await getMission(leafId))!.status).toBe('running');
  });

  // Mirror: the container has NO enabled policy, so the leaf's Task must
  // hold the Mission open no longer than a needs_human Task would.
  it('completes an issue-leaf mission whose only Task is ready_to_merge when the CONTAINER has no enabled auto-merge policy', async () => {
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(containerId, {
      workspaceRepo: 'acme/api',
      issueRef: null,
      parentMissionId: null,
      autoMergePolicy: null,
    });
    await insertMission(leafId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#12',
      parentMissionId: containerId,
      autoMergePolicy: null,
    });

    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const now = new Date();
    await db.insert(schema.tasks).values({
      id: taskId,
      missionId: leafId,
      repo: 'acme/api',
      baseBranch: 'main',
      kind: 'fix',
      status: 'ready_to_merge',
      prUrl: 'https://github.com/acme/api/pull/12',
      prNumber: 12,
      createdAt: now,
      updatedAt: now,
    });

    await runReconciler(noopLog);

    expect((await getMission(leafId))!.status).toBe('completed');
  });

  // Merging sweep's merged branch (reconciler.ts, ~line 352-ish per the
  // review): a claimed sweep/webhook race guard with zero prior coverage.
  // GitHub reports the PR merged, and the sweep CAS-guards its own write on
  // `eq(tasks.status, 'merging')` so a concurrent settle (e.g. the fast-path
  // webhook handler observing the identical fact first) can't be clobbered.
  // We can't rely on real thread interleaving in a single-process test, so —
  // same technique as the webhook route test's CAS race test — we intercept
  // the sweep's own `db.update(tasks)` call, perform the "concurrent" write
  // first, then let the real CAS-guarded write run against the now-changed
  // row. Drop `eq(tasks.status, 'merging')` from that guard and this test
  // fails: the sweep's write would match on id alone and clobber the
  // concurrent transition.
  describe('merging sweep — merged branch CAS guard', () => {
    const prevToken = process.env.GITHUB_APP_TOKEN;

    afterEach(() => {
      vi.restoreAllMocks();
      reconOctokitMocks.pullsGet.mockReset();
      if (prevToken === undefined) delete process.env.GITHUB_APP_TOKEN;
      else process.env.GITHUB_APP_TOKEN = prevToken;
    });

    it('does not clobber a Task a concurrent write already moved out of `merging`', async () => {
      process.env.GITHUB_APP_TOKEN = 'ghp_test';
      reconOctokitMocks.pullsGet.mockResolvedValue({
        data: { merged: true, state: 'closed' },
      });

      const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await insertMission(missionId, {
        workspaceRepo: 'acme/api',
        issueRef: 'acme/api#55',
        parentMissionId: null,
      });
      const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const now = new Date();
      await db.insert(schema.tasks).values({
        id: taskId,
        missionId,
        repo: 'acme/api',
        baseBranch: 'main',
        kind: 'fix',
        status: 'merging',
        prUrl: 'https://github.com/acme/api/pull/55',
        prNumber: 55,
        createdAt: now,
        updatedAt: now,
      });

      const realUpdate = db.update.bind(db);
      const updateSpy = vi.spyOn(db, 'update').mockImplementationOnce((table: unknown) => {
        let setVals: Record<string, unknown> = {};
        let whereCond: unknown;
        return {
          set(vals: Record<string, unknown>) {
            setVals = vals;
            return this;
          },
          where(cond: unknown) {
            whereCond = cond;
            return this;
          },
          returning: () =>
            (async () => {
              // The "concurrent" write: something else (e.g. the fast-path
              // webhook handler) already settled this Task away from
              // `merging` before the sweep's own guarded write executes.
              await realUpdate(schema.tasks)
                .set({ status: 'needs_human', updatedAt: new Date() })
                .where(eq(schema.tasks.id, taskId));

              return realUpdate(table as typeof schema.tasks)
                .set(setVals)
                .where(whereCond as never)
                .returning();
            })(),
        } as never;
      });

      await runReconciler(noopLog);
      updateSpy.mockRestore();

      const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
      // The race's own write landed...
      expect(row!.status).toBe('needs_human');
      // ...but the sweep's `merged` write did not, because its CAS guard no
      // longer matched the (now-changed) current status.
      const events = await db
        .select()
        .from(schema.ledgerEvents)
        .where(eq(schema.ledgerEvents.taskId, taskId));
      expect(events.some((e) => e.eventType === 'auto_merge.merged')).toBe(false);
    });
  });
});

describe('mission terminality', () => {
  it('treats needs_human as terminal — the mission has done all it can alone', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toContain('needs_human');
  });

  describe('missionTerminalStatusesFor — ready_to_merge is conditional on the auto-merge policy', () => {
    it('treats ready_to_merge as terminal when the resolved policy is absent or disabled — nothing but a human will ever move it, same as needs_human', () => {
      expect(missionTerminalStatusesFor(null)).toContain('ready_to_merge');
      expect(missionTerminalStatusesFor({ enabled: false })).toContain('ready_to_merge');
    });

    it('does not treat ready_to_merge as terminal when the resolved policy is enabled — unmerged work keeps the mission open until runAutoMerge/the merging sweep resolve it', () => {
      expect(missionTerminalStatusesFor({ enabled: true })).not.toContain('ready_to_merge');
    });

    it('always includes the bare MISSION_TERMINAL_TASK_STATUSES regardless of policy', () => {
      for (const status of MISSION_TERMINAL_TASK_STATUSES) {
        expect(missionTerminalStatusesFor(null)).toContain(status);
        expect(missionTerminalStatusesFor({ enabled: true })).toContain(status);
      }
    });
  });

  describe('missionTerminalStatusesFor — takes a resolved policy', () => {
    it('treats ready_to_merge as terminal when the resolved policy is null', () => {
      expect(missionTerminalStatusesFor(null)).toContain('ready_to_merge');
    });

    it('treats ready_to_merge as terminal when the resolved policy is disabled', () => {
      expect(missionTerminalStatusesFor({ enabled: false })).toContain('ready_to_merge');
    });

    it('does NOT treat ready_to_merge as terminal when the resolved policy is enabled', () => {
      // Something will merge it; the Mission must stay open until it does.
      expect(missionTerminalStatusesFor({ enabled: true })).not.toContain('ready_to_merge');
    });
  });
});
