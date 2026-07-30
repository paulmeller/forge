import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// tryOpenPr (reconciler.ts) is the server-side fallback that opens a real PR via Octokit
// when an agent pushes a branch but never calls the GitHub MCP create_pull_request tool
// itself. It's exercised here through runReconciler end-to-end against a real libSQL file,
// with only the Octokit client faked — same DB-integration pattern as reconciler.test.ts.
const mockOctokit = vi.hoisted(() => ({
  repos: {
    listBranches: vi.fn(async () => ({ data: [] as Array<{ name: string }> })),
    compareCommits: vi.fn(),
  },
  pulls: {
    list: vi.fn(),
    create: vi.fn(),
  },
  issues: {
    get: vi.fn(),
  },
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

// The continuation path sends a follow-up turn through the backend adapter;
// fake it so no real session is contacted.
type SentTurn = { sessionId: string; text: string; backendSessionRef?: string | null };
const mockAdapter = vi.hoisted(() => ({
  // Typed so tests can inspect which session a turn went to — this file's
  // shared DB means the sweep also processes tasks left by earlier tests.
  sendTurn: vi.fn(async (_input: { sessionId: string; text: string; backendSessionRef?: string | null }) => ({})),
}));
vi.mock('./adapters', () => ({ getAdapter: () => mockAdapter }));

const DB_FILE = `/tmp/forge-recon-pr-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;
process.env.GATE_STALL_MS = '999999999'; // don't let the stall sweep interfere
process.env.GITHUB_APP_TOKEN = 'ghp_test';

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

afterEach(() => {
  vi.clearAllMocks();
  mockOctokit.repos.listBranches.mockResolvedValue({ data: [] });
  delete process.env.TASK_CONTINUATION_MAX;
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
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function insertStalledTask(id: string, missionId: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    status: 'turn_ended',
    prUrl: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function getTask(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return row;
}

async function getLedgerEvents(taskId: string) {
  return db.select().from(schema.ledgerEvents).where(eq(schema.ledgerEvents.taskId, taskId));
}

describe('runReconciler — PR-opening gate (tryOpenPr)', () => {
  it('records an already-open PR via pulls.list without creating a new one', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId);

    mockOctokit.repos.compareCommits.mockResolvedValue({
      data: { ahead_by: 2, total_commits: 2, files: [] },
    });
    mockOctokit.pulls.list.mockResolvedValue({
      data: [{ number: 42, html_url: 'https://github.com/acme/api/pull/42' }],
    });

    await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('awaiting_ci');
    expect(task?.prNumber).toBe(42);
    expect(task?.prUrl).toBe('https://github.com/acme/api/pull/42');
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('creates a PR via pulls.create when none exists, and emits gate.pr_opened', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId, { name: 'Test mission' });
    await insertStalledTask(taskId, missionId, { issueRef: null });

    mockOctokit.repos.compareCommits.mockResolvedValue({
      data: { ahead_by: 1, total_commits: 1, files: [{ filename: 'a.ts' }] },
    });
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });
    mockOctokit.pulls.create.mockResolvedValue({
      data: { number: 7, html_url: 'https://github.com/acme/api/pull/7' },
    });

    await runReconciler(noopLog);

    expect(mockOctokit.pulls.create).toHaveBeenCalledTimes(1);
    const createArgs = mockOctokit.pulls.create.mock.calls[0]![0];
    expect(createArgs).toMatchObject({
      owner: 'acme',
      repo: 'api',
      head: `forge/${taskId}`,
      base: 'main',
      title: 'Forge: Test mission',
    });
    expect(mockOctokit.issues.get).not.toHaveBeenCalled();

    const task = await getTask(taskId);
    expect(task?.status).toBe('awaiting_ci');
    expect(task?.prNumber).toBe(7);
    expect(task?.prUrl).toBe('https://github.com/acme/api/pull/7');

    const events = await getLedgerEvents(taskId);
    const opened = events.find((e) => e.eventType === 'gate.pr_opened');
    expect(opened).toBeDefined();
    expect(opened?.payload).toMatchObject({
      prNumber: 7,
      prUrl: 'https://github.com/acme/api/pull/7',
      branch: `forge/${taskId}`,
      aheadBy: 1,
      openedBy: 'forge-reconciler',
    });
  });

  it('abandons the task when no branch with commits ahead of base is found', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId);

    // Every candidate branch compares as even with base — nothing was ever pushed.
    mockOctokit.repos.compareCommits.mockResolvedValue({ data: { ahead_by: 0 } });

    await runReconciler(noopLog);

    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();

    const task = await getTask(taskId);
    expect(task?.status).toBe('abandoned');

    const events = await getLedgerEvents(taskId);
    const abandoned = events.find((e) => e.eventType === 'task.abandoned');
    expect(abandoned?.payload).toMatchObject({
      reason: 'turn_ended with no PR and no branch found',
    });
  });

  it('nudges a stalled task with a live session instead of abandoning it', async () => {
    process.env.TASK_CONTINUATION_MAX = '3';
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, { sessionId: 'sesn_live' });
    // Forge asks for the push before it nudges, so seed that ask — this test's
    // subject is the continuation nudge, not the push request.
    await db.insert(schema.ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      missionId,
      taskId,
      eventType: 'push.requested',
      payload: {},
      createdAt: new Date(),
    });
    mockOctokit.repos.compareCommits.mockResolvedValue({ data: { ahead_by: 0 } });

    await runReconciler(noopLog);

    // Nudged, not abandoned: a follow-up turn was sent and the task is running.
    expect(mockAdapter.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sesn_live' }),
    );
    const task = await getTask(taskId);
    expect(task?.status).toBe('running');
    const events = await getLedgerEvents(taskId);
    expect(events.some((e) => e.eventType === 'task.continued')).toBe(true);
    expect(events.some((e) => e.eventType === 'task.abandoned')).toBe(false);
  });

  it('escalates to needs_human once the continuation budget is spent', async () => {
    process.env.TASK_CONTINUATION_MAX = '2';
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, { sessionId: 'sesn_stuck' });
    // Forge asks for the push before it nudges, so seed that ask — this test's
    // subject is the continuation nudge, not the push request.
    await db.insert(schema.ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      missionId,
      taskId,
      eventType: 'push.requested',
      payload: {},
      createdAt: new Date(),
    });
    // Two nudges already happened → budget of 2 is spent.
    for (let i = 0; i < 2; i += 1) {
      await db.insert(schema.ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        missionId,
        taskId,
        eventType: 'task.continued',
        payload: { nudge: i + 1 },
        createdAt: new Date(),
      });
    }
    mockOctokit.repos.compareCommits.mockResolvedValue({ data: { ahead_by: 0 } });

    await runReconciler(noopLog);

    // No further nudge; handed to a human with the reason, never abandoned.
    expect(mockAdapter.sendTurn).not.toHaveBeenCalled();
    const task = await getTask(taskId);
    expect(task?.status).toBe('needs_human');
    // Forge had already handed this agent the exact push command (seeded above)
    // and nothing reached the remote, so the honest reason is that it committed
    // nothing — not that a branch went missing.
    expect(task?.escalationReason).toBe('no_commits');
    const events = await getLedgerEvents(taskId);
    expect(events.some((e) => e.eventType === 'gate.escalated')).toBe(true);
    expect(events.some((e) => e.eventType === 'task.abandoned')).toBe(false);
  });
});

describe('runReconciler — reclaiming work stranded by a guardrail halt', () => {
  // A Task halted straight from `running` never passes through `turn_ended`,
  // so the PR sweep never saw it, and the halt escalation infers "no branch"
  // from prUrl being null. Observed live: an agent pushed a correct branch,
  // could not open the PR (egress omits api.github.com), and the Task was
  // escalated stalled_no_branch with the commits orphaned on the remote.
  it('opens the PR and clears the false escalation when a branch actually exists', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, {
      status: 'needs_human',
      escalationReason: 'stalled_no_branch',
      completedAt: new Date(),
      dispatchedAt: new Date(Date.now() - 60_000),
    });

    // A branch the task produced: pushed after dispatch, ahead of base.
    mockOctokit.repos.listBranches.mockResolvedValue({ data: [{ name: 'agent-branch' }] });
    mockOctokit.repos.compareCommits.mockResolvedValue({
      data: {
        ahead_by: 1,
        commits: [{ commit: { committer: { date: new Date().toISOString() } } }],
        files: [{ filename: 'a.ts' }],
      },
    });
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });
    mockOctokit.pulls.create.mockResolvedValue({
      data: { html_url: 'https://github.com/acme/api/pull/7', number: 7 },
    });

    await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.prUrl).toBe('https://github.com/acme/api/pull/7');
    expect(task?.status).toBe('awaiting_ci');
    // The reason it was escalated for is disproven — don't leave a false label.
    expect(task?.escalationReason).toBeNull();
  });

  it('leaves the escalation alone when there is genuinely no branch', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, {
      status: 'needs_human',
      escalationReason: 'stalled_no_branch',
      completedAt: new Date(),
    });
    mockOctokit.repos.compareCommits.mockResolvedValue({ data: { ahead_by: 0 } });

    await runReconciler(noopLog);

    const task = await getTask(taskId);
    expect(task?.status).toBe('needs_human');
    expect(task?.escalationReason).toBe('stalled_no_branch');
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });
});

describe('runReconciler — the PR comes from the Forge-named branch', () => {
  // Forge assigns forge/<taskId> and the agent pushes to it. Discovery is gone:
  // Forge used to list the repo and adopt anything ahead of base, which once
  // attached a six-week-old stranger branch to a task that had pushed nothing.
  it('opens the PR from the Forge-named branch', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, { sessionId: 'sess_1' });

    mockOctokit.repos.compareCommits.mockResolvedValue({
      data: { ahead_by: 1, files: [{ filename: 'a.ts' }] },
    });
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });
    mockOctokit.pulls.create.mockResolvedValue({
      data: { html_url: 'https://github.com/acme/api/pull/9', number: 9 },
    });

    await runReconciler(noopLog);

    expect(mockOctokit.repos.compareCommits).toHaveBeenCalledWith(
      expect.objectContaining({ head: `forge/${taskId}` }),
    );
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ head: `forge/${taskId}` }),
    );
    const task = await getTask(taskId);
    expect(task?.status).toBe('awaiting_ci');
  });

  it('never adopts a branch the agent named itself', async () => {
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    // dispatchedAt in the past so the branch's commit looks "after dispatch" —
    // exactly the condition under which the old provenance-gated discovery
    // WOULD have adopted this stranger branch. Without this the old gate fails
    // closed on a null dispatchedAt and the test proves nothing.
    await insertStalledTask(taskId, missionId, {
      sessionId: 'sess_2',
      dispatchedAt: new Date(Date.now() - 3_600_000),
    });

    // The discriminating case: a stray agent-named branch that IS ahead of
    // base, while forge/<taskId> does not exist. The old discovery would list
    // the repo, find this branch, and open a PR from it. An exact-name check
    // must not — the branch is not this task's, whatever its commit dates say.
    mockOctokit.repos.listBranches.mockResolvedValue({ data: [{ name: 'claude/some-slug' }] });
    mockOctokit.repos.compareCommits.mockImplementation(async ({ head }) => {
      if (head === 'claude/some-slug') {
        return {
          data: {
            ahead_by: 3,
            files: [{ filename: 'x.ts' }],
            commits: [{ commit: { committer: { date: new Date().toISOString() } } }],
          },
        };
      }
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });

    await runReconciler(noopLog);

    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });
});

describe('runReconciler — Forge dictates the salvage push (#56)', () => {
  // The agent is told to push to forge/<taskId>, but may commit and forget, or
  // push under its own name. Forge then sends the exact command rather than
  // searching for whatever branch appeared — the agent is a shell for a command
  // Forge wrote, with no naming choice.
  const noBranch = () =>
    mockOctokit.repos.compareCommits.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

  it('sends the exact push command targeting the Forge-named branch', async () => {
    noBranch();
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, { sessionId: 'sess_push' });

    await runReconciler(noopLog);

    const sent = mockAdapter.sendTurn.mock.calls
      .map((c) => c[0] as SentTurn)
      .find((a) => a.sessionId === 'sess_push');
    expect(sent?.text).toContain(`git push origin HEAD:forge/${taskId}`);
    const events = await getLedgerEvents(taskId);
    expect(events.some((e) => e.eventType === 'push.requested')).toBe(true);
    // Still turn_ended — the next tick re-checks the branch.
    expect((await getTask(taskId))?.status).toBe('turn_ended');
  });

  it('escalates no_commits once a push was asked for and the continuation budget is spent', async () => {
    noBranch();
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, { sessionId: 'sess_spent' });
    // A push was already requested, and the nudge budget is exhausted.
    for (const t of ['push.requested', 'task.continued', 'task.continued', 'task.continued']) {
      await db.insert(schema.ledgerEvents).values({
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        missionId,
        taskId,
        eventType: t,
        payload: {},
        createdAt: new Date(),
      });
    }

    await runReconciler(noopLog);

    const toThisSession = mockAdapter.sendTurn.mock.calls
      .map((c) => c[0] as SentTurn)
      .filter((a) => a.sessionId === 'sess_spent');
    expect(toThisSession).toHaveLength(0);
    const task = await getTask(taskId);
    expect(task?.status).toBe('needs_human');
    expect(task?.escalationReason).toBe('no_commits');
  });
});

describe('runReconciler — reclaims work pushed before a halt (#62 via exact name)', () => {
  it('reclaims a no_commits escalation when the Forge-named branch does exist', async () => {
    // A guardrail can halt an agent after it pushed. The escalation said there
    // was nothing on the remote; the branch proves otherwise, so the label was
    // wrong on its face and the work must not be stranded.
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, {
      status: 'needs_human',
      escalationReason: 'no_commits',
      completedAt: new Date(),
    });

    mockOctokit.repos.compareCommits.mockResolvedValue({
      data: { ahead_by: 1, files: [{ filename: 'a.ts' }] },
    });
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });
    mockOctokit.pulls.create.mockResolvedValue({
      data: { html_url: 'https://github.com/acme/api/pull/12', number: 12 },
    });

    await runReconciler(noopLog);

    expect(mockOctokit.repos.compareCommits).toHaveBeenCalledWith(
      expect.objectContaining({ head: `forge/${taskId}` }),
    );
    const task = await getTask(taskId);
    expect(task?.status).toBe('awaiting_ci');
    expect(task?.escalationReason).toBeNull();
  });
});

describe('runReconciler — a reproduce Task that pushed work is not abandoned (#70)', () => {
  it('opens the PR from the Forge-named branch instead of abandoning for no verdict', async () => {
    // #67 live: triage gave a *feature* issue a reproduce->fix shape. There was
    // no verdict to emit, so the agent built the feature, committed, and pushed
    // to the branch Forge assigned. Step 0b then abandoned it for emitting no
    // verdict — by design, it settles reproduce Tasks before the PR sweep so
    // they are "never mistaken for" having pushed. 488 lines were orphaned on
    // the remote. Work on the remote outranks a missing verdict.
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, { kind: 'reproduce', sessionId: 'sess_repro' });

    mockOctokit.repos.compareCommits.mockResolvedValue({
      data: { ahead_by: 3, files: [{ filename: 'a.ts' }] },
    });
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });
    mockOctokit.pulls.create.mockResolvedValue({
      data: { html_url: 'https://github.com/acme/api/pull/70', number: 70 },
    });

    await runReconciler(noopLog);

    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ head: `forge/${taskId}` }),
    );
    const task = await getTask(taskId);
    expect(task?.status).toBe('awaiting_ci');
    expect(task?.status).not.toBe('abandoned');
  });

  it('still abandons a reproduce Task that pushed nothing', async () => {
    // The guard must not turn every verdict-less reproduce Task into a stuck
    // one — with no branch there is genuinely nothing to salvage.
    const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(missionId);
    await insertStalledTask(taskId, missionId, { kind: 'reproduce', sessionId: 'sess_none' });

    mockOctokit.repos.compareCommits.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

    await runReconciler(noopLog);

    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
    expect((await getTask(taskId))?.status).toBe('abandoned');
  });
});
