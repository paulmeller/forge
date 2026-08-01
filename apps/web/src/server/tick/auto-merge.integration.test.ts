import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// runAutoMerge's candidate-selection query is the exact defect this task
// exists to fix: it must select `ready_to_merge` Tasks and must NEVER select
// `needs_human` Tasks, however small their diff. The unit-mocked
// auto-merge.test.ts fakes `db.select().where(...)` to just return whatever
// the test seeded, ignoring the real WHERE clause entirely — a needs_human
// row seeded there would pass or fail independent of production's
// `eq(tasks.status, 'ready_to_merge')` filter, which is not a real
// regression guard. This file runs the real query against a live SQLite DB
// instead, with only Octokit faked — same DB-integration pattern as
// reconciler-pr.test.ts / budgets.integration.test.ts.

const mockOctokit = vi.hoisted(() => ({
  pulls: { get: vi.fn(), merge: vi.fn(), listFiles: vi.fn() },
  repos: { getBranchProtection: vi.fn() },
  graphql: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

const DB_FILE = `/tmp/forge-auto-merge-int-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;
process.env.GITHUB_APP_TOKEN = 'ghp_test';

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let runAutoMerge: typeof import('./auto-merge').runAutoMerge;

const noopLog = { info: () => {}, warn: () => {} };

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ runAutoMerge } = await import('./auto-merge'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

// M6: without this, the file was only order-independent by accident —
// test 3 ('does not select a queued task...') asserted `candidates === 0`,
// which was only true because test 2 ('does select a ready_to_merge task...')
// had already merged (and thereby moved out of ready_to_merge) the one row
// it created. Running that test alone, or reordering the file, would have
// left a stray ready_to_merge row bleeding into later tests. Missions cascade
// to tasks (schema.ts's onDelete: 'cascade'), so clearing missions is enough.
beforeEach(async () => {
  await db.delete(schema.missions);
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
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    autoMergePolicy: { enabled: true },
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
    repo: 'acme/repo',
    baseBranch: 'main',
    status: 'ready_to_merge',
    prUrl: 'https://github.com/acme/repo/pull/7',
    prNumber: 7,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

describe('runAutoMerge — candidate selection (real query, live SQLite)', () => {
  it('never selects a task that escalated to needs_human', async () => {
    // A task the AI reviewer rejected three times must not be merge-eligible,
    // however small its diff. This is the defect the status split exists to
    // prevent, and the guarantee this test encodes for real: if the
    // candidate query is ever widened back to include needs_human, this
    // fails.
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, {
      status: 'needs_human',
      escalationReason: 'ai_review_rejected',
    });

    const result = await runAutoMerge(noopLog);

    expect(result.candidates).toBe(0);
    expect(mockOctokit.pulls.merge).not.toHaveBeenCalled();
    expect(mockOctokit.graphql).not.toHaveBeenCalled();
  });

  it('does select a ready_to_merge task with a PR url (positive control)', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, { status: 'ready_to_merge' });

    mockOctokit.pulls.get.mockResolvedValue({
      data: {
        state: 'open',
        additions: 5,
        deletions: 2,
        changed_files: 1,
        node_id: 'PR_control',
        base: { ref: 'main' },
      },
    });
    mockOctokit.repos.getBranchProtection.mockResolvedValue({
      data: { required_status_checks: { contexts: ['build'] } },
    });
    mockOctokit.graphql.mockResolvedValue({});

    const result = await runAutoMerge(noopLog);

    expect(result.candidates).toBe(1);
    expect(result.merged).toBe(1);
  });

  it('does not select a queued task, even with a PR url and matching mission', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, { status: 'queued' });

    const result = await runAutoMerge(noopLog);

    expect(result.candidates).toBe(0);
  });

  it('never selects a ready_to_merge task whose mission was cancelled (#82)', async () => {
    // #46's cancelMission only abandons queued/dispatching/running/turn_ended
    // Tasks — one already past the agent and sitting in ready_to_merge is
    // untouched by that abandon set. Without a mission-status filter here,
    // this candidate query would still pick it up and GitHub's native
    // auto-merge could fire on work the operator already cancelled.
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, { status: 'cancelled' });
    await insertTask(taskId, missionId, { status: 'ready_to_merge' });

    const result = await runAutoMerge(noopLog);

    expect(result.candidates).toBe(0);
    expect(mockOctokit.graphql).not.toHaveBeenCalled();
  });

  it('selects a leaf Task when only the CONTAINER has auto-merge enabled', async () => {
    // The whole point of the resolver: a repo-level toggle must reach the
    // issue-leaf missions that actually own the Tasks.
    //
    // M1: this used to assert only `result.candidates === 1`, which comes
    // from the raw `WHERE status = 'ready_to_merge'` query (auto-merge.ts's
    // `candidates` select) — that query doesn't even look at autoMergePolicy,
    // so it can't tell "the resolver correctly read through to the
    // container" apart from "the resolver was never consulted at all".
    // `resolvePolicyCached`/`resolveAutoMergePolicy` — the actual parent
    // lookup this test exists to cover — only gets exercised on the path to
    // `result.merged`. Asserting `merged` instead (with the Octokit calls
    // mocked the same way the positive-control test above does) means a
    // broken parent-lookup (e.g. resolving the leaf's own null policy
    // instead of reading through to the container) fails this test, not just
    // its sibling.
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(containerId, { autoMergePolicy: { enabled: true } });
    await insertMission(leafId, { parentMissionId: containerId, autoMergePolicy: null });
    await insertTask(taskId, leafId, { status: 'ready_to_merge' });

    mockOctokit.pulls.get.mockResolvedValue({
      data: {
        state: 'open',
        additions: 5,
        deletions: 2,
        changed_files: 1,
        node_id: 'PR_leaf_container',
        base: { ref: 'main' },
      },
    });
    mockOctokit.repos.getBranchProtection.mockResolvedValue({
      data: { required_status_checks: { contexts: ['build'] } },
    });
    mockOctokit.graphql.mockResolvedValue({});

    const result = await runAutoMerge(noopLog);

    expect(result.candidates).toBe(1);
    expect(result.merged).toBe(1);
  });

  it('a repo-level toggle enabled AFTER a leaf Task already sits in ready_to_merge frees it on the very next run (live, not copied)', async () => {
    // This is the reason resolveAutoMergePolicy is a live lookup rather than
    // a value copied onto the leaf at creation time: enabling auto-merge on
    // a repo must reach Tasks that already existed before the toggle
    // flipped, not just future ones. `result.candidates` alone can't prove
    // this — it counts every ready_to_merge/prUrl row regardless of policy —
    // so this asserts on whether runAutoMerge actually acted (armed a merge)
    // instead.
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(containerId, { autoMergePolicy: { enabled: false } });
    await insertMission(leafId, { parentMissionId: containerId, autoMergePolicy: null });
    await insertTask(taskId, leafId, { status: 'ready_to_merge' });

    // Disabled on the container: runAutoMerge must not act on the leaf's Task.
    const before = await runAutoMerge(noopLog);
    expect(before.merged).toBe(0);
    expect(mockOctokit.graphql).not.toHaveBeenCalled();

    // Flip the CONTAINER's policy live — the leaf row itself is never touched.
    await db
      .update(schema.missions)
      .set({ autoMergePolicy: { enabled: true } })
      .where(eq(schema.missions.id, containerId));

    mockOctokit.pulls.get.mockResolvedValue({
      data: {
        state: 'open',
        additions: 5,
        deletions: 2,
        changed_files: 1,
        node_id: 'PR_live_lookup',
        base: { ref: 'main' },
      },
    });
    mockOctokit.repos.getBranchProtection.mockResolvedValue({
      data: { required_status_checks: { contexts: ['build'] } },
    });
    mockOctokit.graphql.mockResolvedValue({});

    const after = await runAutoMerge(noopLog);
    expect(after.merged).toBe(1);
  });

  // #53: task-review.ts's reviewTask() lets an operator Approve a
  // needs_human Task that has no PR (the stalled_no_branch escalation, or
  // any older null-prUrl path) — Approve sets ready_to_merge with prUrl
  // still null. Before this fix, the candidate query's `isNotNull(prUrl)`
  // filter made that row invisible to runAutoMerge entirely, so it just sat
  // in ready_to_merge until the reconciler's merge-stall sweep re-escalated
  // it MERGE_STALL_MS later — a silent, confusing round-trip for whoever
  // clicked Approve on it.
  it('a ready_to_merge task with no PR is escalated back to needs_human immediately, not left for the merge-stall sweep', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertTask(taskId, missionId, {
      prUrl: null,
      prNumber: null,
      approvedBy: 'user_1',
    });

    const result = await runAutoMerge(noopLog);

    // It must be seen (candidates) and acted on (blocked), not silently
    // skipped the way the isNotNull filter used to skip it.
    expect(result.candidates).toBe(1);
    expect(result.blocked).toBe(1);
    expect(mockOctokit.pulls.get).not.toHaveBeenCalled();

    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(task?.status).toBe('needs_human');
    expect(task?.escalationReason).toBe('ready_to_merge_no_pr');
    // A rollback to needs_human must not carry the old approval forward —
    // same rule tryMerge's rollback path follows for auto_merge_failed.
    expect(task?.approvedBy).toBeNull();
  });
});
