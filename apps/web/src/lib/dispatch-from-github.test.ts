import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

import type { RepoPolicy } from '@forge/db';

// Real libSQL file + migrations, same pattern as reconciler.integration.test.ts
// and the forge/github webhook route test — exercises the actual gate
// (dispatchFromGithub → getRepoPolicy → runPlanner) and the real dispatcher's
// `WHERE status = 'running'` query, rather than mocked db calls that could
// happily "pass" a gate that isn't actually wired up.
const DB_FILE = `/tmp/forge-dispatch-github-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

// Mocked exactly like ci.test.ts's Octokit mock — no real GitHub API calls.
const octokitMocks = vi.hoisted(() => ({
  createComment: vi.fn(async () => ({ data: {} })),
}));
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => ({
    issues: { createComment: octokitMocks.createComment },
  })),
}));

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let dispatchFromGithub: typeof import('./dispatch-from-github').dispatchFromGithub;
let parseForgeDirective: typeof import('./dispatch-from-github').parseForgeDirective;
let runDispatcher: typeof import('@/server/tick/dispatcher').runDispatcher;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ dispatchFromGithub, parseForgeDirective } = await import('./dispatch-from-github'));
  ({ runDispatcher } = await import('@/server/tick/dispatcher'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

beforeEach(async () => {
  // Cascade delete (schema.ts's onDelete: 'cascade') clears tasks + ledger
  // events for missions, and repo rows for installations.
  await db.delete(schema.missions);
  await db.delete(schema.githubInstallations);
  octokitMocks.createComment.mockClear();
  delete process.env.GITHUB_APP_TOKEN;
  delete process.env.BETTER_AUTH_URL;
});

afterEach(() => {
  delete process.env.GITHUB_APP_TOKEN;
  delete process.env.BETTER_AUTH_URL;
});

const log = { info: () => {}, warn: () => {}, error: () => {} };

async function missionRow(id: string) {
  const [row] = await db.select().from(schema.missions).where(eq(schema.missions.id, id)).limit(1);
  return row;
}

async function tasksFor(missionId: string) {
  return db.select().from(schema.tasks).where(eq(schema.tasks.missionId, missionId));
}

async function ledgerEventsFor(missionId: string) {
  return db.select().from(schema.ledgerEvents).where(eq(schema.ledgerEvents.missionId, missionId));
}

/** Test-only helper: no repo-policy UI/API exists yet, so write the row directly. */
async function setRepoPolicy(repo: string, policy: RepoPolicy) {
  const now = new Date();
  const installationId = `ghi_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await db.insert(schema.githubInstallations).values({
    id: installationId,
    userId: 'user_test',
    installationId: Math.floor(Math.random() * 1_000_000),
    accountLogin: repo.split('/')[0] ?? 'acme',
    accountType: 'Organization',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubInstallationRepos).values({
    id: `ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    installationId,
    repo,
    repoPolicy: policy,
    createdAt: now,
  });
}

describe('parseForgeDirective', () => {
  it('returns null for empty/null/undefined', () => {
    expect(parseForgeDirective(null)).toBeNull();
    expect(parseForgeDirective(undefined)).toBeNull();
    expect(parseForgeDirective('')).toBeNull();
  });

  it('parses @forge directive on a single line', () => {
    expect(parseForgeDirective('@forge bump fast-glob to ^3.3.2')).toBe('bump fast-glob to ^3.3.2');
  });

  it('parses /forge directive', () => {
    expect(parseForgeDirective('/forge add OTel spans to every HTTP handler')).toBe(
      'add OTel spans to every HTTP handler',
    );
  });

  it('finds the directive on any line of a multi-line comment', () => {
    const body = `Hey team — let's also do this:

@forge bump fast-glob to ^3.3.2

cc @others`;
    expect(parseForgeDirective(body)).toBe('bump fast-glob to ^3.3.2');
  });

  it('is case-insensitive on the trigger', () => {
    expect(parseForgeDirective('@FORGE bump it')).toBe('bump it');
    expect(parseForgeDirective('@Forge bump it')).toBe('bump it');
  });

  it('ignores @forge with no payload', () => {
    expect(parseForgeDirective('@forge')).toBeNull();
    expect(parseForgeDirective('@forge   ')).toBeNull();
  });

  it('does not match @forge inside a sentence', () => {
    // Trigger must be at line start (after optional whitespace)
    expect(parseForgeDirective('we should ask @forge to bump it')).toBeNull();
  });

  it('takes the first directive line if multiple', () => {
    expect(parseForgeDirective('@forge first thing\n@forge second thing')).toBe('first thing');
  });

  it('handles leading whitespace before the trigger', () => {
    expect(parseForgeDirective('   @forge indented')).toBe('indented');
  });
});

describe('dispatchFromGithub — plan-approval gate', () => {
  it('creates a mission awaiting plan approval by default', async () => {
    const { mission } = await dispatchFromGithub({
      repoFullName: 'a/b',
      goal: 'fix it',
      defaultBranch: 'main',
      triggeredBy: 'octocat',
    });
    // Default is gated: @forge must not dispatch straight to an agent.
    expect((await missionRow(mission.id))?.status).toBe('planning');
    expect((await missionRow(mission.id))?.startedAt).toBeNull();
  });

  it('does not dispatch a gated mission — the dispatcher never even claims its Task', async () => {
    const { mission } = await dispatchFromGithub({
      repoFullName: 'a/b',
      goal: 'fix it',
      defaultBranch: 'main',
      triggeredBy: 'octocat',
    });

    const res = await runDispatcher(log);

    // Not merely "status differs": the real dispatcher, given the real
    // Mission row, must never claim (queued -> dispatching) this Task.
    expect(res.dispatched).toBe(0);
    expect(res.claimed).toBe(0);

    const tasks = await tasksFor(mission.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe('queued'); // untouched by the dispatcher
    expect((await missionRow(mission.id))?.status).toBe('planning');
  });

  it('runs immediately when the repo opts out of plan approval', async () => {
    await setRepoPolicy('a/b', { requirePlanApproval: false });
    const { mission, taskId } = await dispatchFromGithub({
      repoFullName: 'a/b',
      goal: 'fix it',
      defaultBranch: 'main',
      triggeredBy: 'octocat',
    });
    expect((await missionRow(mission.id))?.status).toBe('running');
    expect(taskId).toBeTruthy();

    // The pre-existing immediate-dispatch behaviour survives: exactly one
    // queued Task, plus the pre-existing ledger trail (mission.started).
    const tasks = await tasksFor(mission.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe('queued');
    const events = await ledgerEventsFor(mission.id);
    expect(events.some((e) => e.eventType === 'mission.started')).toBe(true);
  });

  // I4: unit-level isolation of dispatchFromGithub's own gate logic, distinct
  // from the end-to-end check_suite webhook test (route.test.ts) which
  // additionally proves handleCheckSuite actually passes the flag. This test
  // instead pins that dispatchFromGithub itself honours the flag when
  // called directly — reverting `gated = policy.requirePlanApproval &&
  // !input.bypassPlanApprovalGate` back to `gated = policy.requirePlanApproval`
  // fails only this one, not the route-level test (which would still pass
  // if some OTHER caller forgot to set the flag on a repo that happens to
  // already be ungated).
  describe('bypassPlanApprovalGate (I4 — self-healing CI exemption)', () => {
    it('runs immediately even though the repo defaults to plan-approval-gated', async () => {
      const { mission, taskId } = await dispatchFromGithub({
        repoFullName: 'a/ci-fix',
        goal: 'fix the lint errors',
        defaultBranch: 'main',
        triggeredBy: 'ci-fix (github)',
        bypassPlanApprovalGate: true,
      });
      expect((await missionRow(mission.id))?.status).toBe('running');
      expect((await missionRow(mission.id))?.startedAt).not.toBeNull();
      expect(taskId).toBeTruthy();

      const tasks = await tasksFor(mission.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.status).toBe('queued');
    });

    it('does not post a plan-approval comment when bypassed (there is no plan to approve)', async () => {
      process.env.GITHUB_APP_TOKEN = 'ghp_test';
      process.env.BETTER_AUTH_URL = 'https://forge.example.com';
      await dispatchFromGithub({
        repoFullName: 'a/ci-fix-2',
        goal: 'fix the lint errors',
        defaultBranch: 'main',
        issueRef: 'a/ci-fix-2#5',
        triggeredBy: 'ci-fix (github)',
        bypassPlanApprovalGate: true,
      });
      expect(octokitMocks.createComment).not.toHaveBeenCalled();
    });

    it('still gates normally when the flag is left unset (default @forge comment behaviour is unaffected)', async () => {
      const { mission } = await dispatchFromGithub({
        repoFullName: 'a/still-gated',
        goal: 'fix it',
        defaultBranch: 'main',
        triggeredBy: 'octocat',
      });
      expect((await missionRow(mission.id))?.status).toBe('planning');
      expect((await missionRow(mission.id))?.startedAt).toBeNull();
    });
  });

  it('creates exactly one Task for a gated mission (planned by runPlanner, not a leftover placeholder)', async () => {
    const { mission, taskId } = await dispatchFromGithub({
      repoFullName: 'a/b',
      goal: 'fix it',
      defaultBranch: 'main',
      triggeredBy: 'octocat',
    });
    const tasks = await tasksFor(mission.id);
    expect(tasks).toHaveLength(1);
    expect(taskId).toBe(tasks[0]?.id);
  });

  it('propagates a non-main baseBranch to the gated Task, matching the ungated path (Finding 1)', async () => {
    const { mission, taskId } = await dispatchFromGithub({
      repoFullName: 'a/b',
      goal: 'fix it',
      defaultBranch: 'develop',
      triggeredBy: 'octocat',
    });
    const tasks = await tasksFor(mission.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(taskId);
    expect(tasks[0]?.baseBranch).toBe('develop');
  });

  it('propagates issueRef to the gated Task, matching the ungated path (Finding 1)', async () => {
    const { mission, taskId } = await dispatchFromGithub({
      repoFullName: 'a/b',
      goal: 'fix it',
      defaultBranch: 'develop',
      issueRef: 'a/b#123',
      triggeredBy: 'octocat',
    });
    const tasks = await tasksFor(mission.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(taskId);
    expect(tasks[0]?.issueRef).toBe('a/b#123');
  });

  it('gated and ungated paths agree on baseBranch/issueRef for the same input', async () => {
    await setRepoPolicy('a/ungated', { requirePlanApproval: false });

    const gated = await dispatchFromGithub({
      repoFullName: 'a/gated',
      goal: 'fix it',
      defaultBranch: 'develop',
      issueRef: 'a/gated#9',
      triggeredBy: 'octocat',
    });
    const ungated = await dispatchFromGithub({
      repoFullName: 'a/ungated',
      goal: 'fix it',
      defaultBranch: 'develop',
      issueRef: 'a/ungated#9',
      triggeredBy: 'octocat',
    });

    const [gatedTask] = await tasksFor(gated.mission.id);
    const [ungatedTask] = await tasksFor(ungated.mission.id);
    expect(gatedTask?.baseBranch).toBe('develop');
    expect(ungatedTask?.baseBranch).toBe('develop');
    expect(gatedTask?.issueRef).toBe('a/gated#9');
    expect(ungatedTask?.issueRef).toBe('a/ungated#9');
  });

  it('does not post a GitHub comment when the trigger has no issueRef, even with a token and URL configured', async () => {
    // GITHUB_APP_TOKEN and BETTER_AUTH_URL are both valid here so this test
    // exercises only the `!input.issueRef` clause — if that clause were
    // deleted, execution would reach the Octokit call and this would fail
    // (Finding 4: the old version of this test left GITHUB_APP_TOKEN unset
    // too, so it couldn't distinguish the two guards).
    process.env.GITHUB_APP_TOKEN = 'ghp_test';
    process.env.BETTER_AUTH_URL = 'https://forge.example.com';
    await dispatchFromGithub({
      repoFullName: 'a/b',
      goal: 'fix it',
      defaultBranch: 'main',
      triggeredBy: 'octocat',
    });
    expect(octokitMocks.createComment).not.toHaveBeenCalled();
  });

  it('posts an approval-link comment on the triggering issue when gated', async () => {
    process.env.GITHUB_APP_TOKEN = 'ghp_test';
    process.env.BETTER_AUTH_URL = 'https://forge.example.com';
    const { mission } = await dispatchFromGithub({
      repoFullName: 'a/c',
      goal: 'fix it',
      defaultBranch: 'main',
      issueRef: 'a/c#42',
      triggeredBy: 'octocat',
    });

    expect(octokitMocks.createComment).toHaveBeenCalledTimes(1);
    const calls = octokitMocks.createComment.mock.calls as unknown as Array<
      [{ owner: string; repo: string; issue_number: number; body: string }]
    >;
    const call = calls[0]![0];
    expect(call).toMatchObject({ owner: 'a', repo: 'c', issue_number: 42 });
    expect(call.body).toContain('https://forge.example.com');
    expect(call.body).toContain(`/missions/${mission.id}/plan`);
  });

  it('does not post a comment (and does not throw) when GITHUB_APP_TOKEN is unset, even with issueRef and BETTER_AUTH_URL configured', async () => {
    // BETTER_AUTH_URL is configured and issueRef is present here so this
    // test exercises only the `!env.GITHUB_APP_TOKEN` clause — if that
    // clause were deleted, execution would reach the Octokit call and this
    // would fail (Finding 4 applied symmetrically).
    process.env.BETTER_AUTH_URL = 'https://forge.example.com';
    const { mission } = await dispatchFromGithub({
      repoFullName: 'a/c',
      goal: 'fix it',
      defaultBranch: 'main',
      issueRef: 'a/c#42',
      triggeredBy: 'octocat',
    });
    expect(octokitMocks.createComment).not.toHaveBeenCalled();
    expect((await missionRow(mission.id))?.status).toBe('planning');
  });

  it('does not post a comment when BETTER_AUTH_URL is left at its localhost default (Finding 2)', async () => {
    // issueRef and GITHUB_APP_TOKEN are both valid; BETTER_AUTH_URL is
    // deliberately left unset (the beforeEach hook already deletes it), so
    // env.BETTER_AUTH_URL resolves to the truthy 'http://localhost:3000'
    // fallback. A guard that merely checks `!env.BETTER_AUTH_URL` cannot
    // catch this — it must check BETTER_AUTH_URL_IS_CONFIGURED instead.
    process.env.GITHUB_APP_TOKEN = 'ghp_test';
    const { mission } = await dispatchFromGithub({
      repoFullName: 'a/c',
      goal: 'fix it',
      defaultBranch: 'main',
      issueRef: 'a/c#42',
      triggeredBy: 'octocat',
    });
    expect(octokitMocks.createComment).not.toHaveBeenCalled();
    expect((await missionRow(mission.id))?.status).toBe('planning');
  });

  it('does not fail the dispatch when posting the GitHub comment throws (best-effort)', async () => {
    process.env.GITHUB_APP_TOKEN = 'ghp_test';
    process.env.BETTER_AUTH_URL = 'https://forge.example.com';
    octokitMocks.createComment.mockRejectedValueOnce(new Error('GitHub API down'));

    const result = await dispatchFromGithub({
      repoFullName: 'a/d',
      goal: 'fix it',
      defaultBranch: 'main',
      issueRef: 'a/d#7',
      triggeredBy: 'octocat',
    });

    // The Mission still exists, planned, despite the comment failure.
    expect((await missionRow(result.mission.id))?.status).toBe('planning');
    expect(octokitMocks.createComment).toHaveBeenCalledTimes(1);
    const tasks = await tasksFor(result.mission.id);
    expect(tasks).toHaveLength(1);
  });
});
