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
});

afterEach(() => {
  delete process.env.GITHUB_APP_TOKEN;
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

  it('does not post a GitHub comment when the trigger has no issueRef', async () => {
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
    expect(call.body).toContain(`/missions/${mission.id}/plan`);
  });

  it('does not post a comment (and does not throw) when GITHUB_APP_TOKEN is unset', async () => {
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
    const tasks = await tasksFor(result.mission.id);
    expect(tasks).toHaveLength(1);
  });
});
