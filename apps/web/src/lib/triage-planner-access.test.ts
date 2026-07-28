import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

import type { IssueSearchResult, TriageIssue } from './triage-planner';

/**
 * The triage Planner's repo-access gate.
 *
 * `issueQuery` is caller-supplied and runs verbatim against GitHub's search
 * API with the server-wide GITHUB_APP_TOKEN, so the repos it returns are
 * chosen by the caller. Nothing earlier in the flow can gate them:
 * createMissionForUser's check keys on `targetRepos`, which a triage Mission
 * leaves empty, and the repos are unknowable until the search has run. Task
 * rows carry `repo` straight through to the dispatcher, which clones
 * `https://github.com/${task.repo}` with the App token and opens PRs on it.
 *
 * These tests use the REAL DB-backed userCanAccessRepo against real
 * installation rows (see grantRepoAccess), so nothing here can pass by
 * agreeing with a mock. The one exception is the fails-closed test, which
 * overrides a single call to make the lookup throw.
 */

const DB_FILE = `/tmp/forge-triage-access-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({ userCanAccessRepo: vi.fn() }));
vi.mock('./mission-defaults-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mission-defaults-db')>();
  mocks.userCanAccessRepo.mockImplementation(actual.userCanAccessRepo);
  return { ...actual, userCanAccessRepo: mocks.userCanAccessRepo };
});

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let runTriagePlanner: typeof import('./triage-planner').runTriagePlanner;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ runTriagePlanner } = await import('./triage-planner'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

beforeEach(async () => {
  await db.delete(schema.ledgerEvents);
  await db.delete(schema.tasks);
  await db.delete(schema.missions);
  // github_installations cascades to github_installation_repos.
  await db.delete(schema.githubInstallations);
  mocks.userCanAccessRepo.mockClear();
});

/** Grants `userId` access to `repo` exactly the way a real Setup installation does. */
async function grantRepoAccess(userId: string, repo: string) {
  const now = new Date();
  const installationRowId = `ghi_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await db.insert(schema.githubInstallations).values({
    id: installationRowId,
    userId,
    installationId: Math.floor(Math.random() * 1_000_000),
    accountLogin: repo.split('/')[0] ?? 'acme',
    accountType: 'Organization',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubInstallationRepos).values({
    id: `ghr_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    installationId: installationRowId,
    repo,
    createdAt: now,
  });
}

/** A draft triage Mission owned by `userId`, exactly as POST /api/v1/missions creates it. */
async function seedTriageMission(id: string, userId: string, issueQuery: string) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id,
    userId,
    name: 'Triage',
    goal: 'triage the backlog',
    status: 'draft',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'triage',
    // The attack's shape: no targetRepos at all, so createMissionForUser's
    // repo gate never ran.
    targetRepos: [],
    issueQuery,
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
  });
}

const issue = (repo: string, number: number): TriageIssue => ({
  repo,
  number,
  title: `bug ${number}`,
  body: 'body',
  labels: [],
  url: `https://github.com/${repo}/issues/${number}`,
});

function searchReturning(issues: TriageIssue[], totalCount = issues.length) {
  return {
    listIssues: async (): Promise<IssueSearchResult> => ({ issues, totalCount }),
  };
}

async function taskRepos(missionId: string): Promise<string[]> {
  const rows = await db
    .select({ repo: schema.tasks.repo })
    .from(schema.tasks)
    .where(eq(schema.tasks.missionId, missionId));
  return [...new Set(rows.map((r) => r.repo))].sort();
}

async function plannerEmitted(missionId: string) {
  const [row] = await db
    .select()
    .from(schema.ledgerEvents)
    .where(eq(schema.ledgerEvents.missionId, missionId))
    .limit(1);
  return row?.payload as Record<string, unknown> | undefined;
}

describe('runTriagePlanner — repo access gate', () => {
  // POSITIVE DIRECTION. Without this, a filter stuck at "deny everything"
  // would satisfy every negative test below while breaking the feature
  // outright — one negative test cannot pin a filter's polarity.
  it('plans Tasks for issues in a repo the caller genuinely has an installation for', async () => {
    await grantRepoAccess('u_ok', 'mine-org/mine-repo');
    await seedTriageMission('msn_ok', 'u_ok', 'org:mine-org is:issue');

    const result = await runTriagePlanner(
      'msn_ok',
      searchReturning([issue('mine-org/mine-repo', 1), issue('mine-org/mine-repo', 2)]),
    );

    // Two issues → a reproduce+fix pair each.
    expect(result.taskCount).toBe(4);
    expect(await taskRepos('msn_ok')).toEqual(['mine-org/mine-repo']);
    expect(result.skipped).toEqual({ issueCount: 0, repos: [] });
  });

  // NEGATIVE DIRECTION — the attack itself.
  it('plans no Task at all for a repo the caller has no installation for', async () => {
    // The caller has a real installation (so this can't pass via some
    // unrelated "no installation configured" failure) — just not one
    // covering the repo their query names.
    await grantRepoAccess('u_attacker', 'attacker-org/own-repo');
    await seedTriageMission('msn_attack', 'u_attacker', 'repo:victim-org/private is:issue');

    const result = await runTriagePlanner(
      'msn_attack',
      searchReturning([issue('victim-org/private', 7), issue('victim-org/private', 8)]),
    );

    expect(result.taskCount).toBe(0);
    // Nothing the dispatcher could clone with the App token.
    expect(await taskRepos('msn_attack')).toEqual([]);
  });

  // Both directions in ONE run: a query legitimately spanning a repo the
  // caller owns and one they don't must plan the former and drop the latter.
  // This is the case a hard failure would have made unrunnable, and the case
  // a broken filter would get exactly backwards.
  it('plans only the accessible repo when one search mixes accessible and inaccessible repos', async () => {
    await grantRepoAccess('u_mixed', 'mixed-org/mine');
    await seedTriageMission('msn_mixed', 'u_mixed', 'is:issue label:bug');

    const result = await runTriagePlanner(
      'msn_mixed',
      searchReturning([
        issue('mixed-org/mine', 1),
        issue('other-tenant/private', 2),
        issue('other-tenant/private', 3),
      ]),
    );

    expect(await taskRepos('msn_mixed')).toEqual(['mixed-org/mine']);
    expect(result.taskCount).toBe(2);
    expect(result.skipped).toEqual({ issueCount: 2, repos: ['other-tenant/private'] });
  });

  // A drop the operator cannot see is its own kind of lie — the whole reason
  // dropping is acceptable at all instead of failing the plan.
  it('records the dropped issues and repos in the planner.emitted ledger event', async () => {
    await grantRepoAccess('u_ledger', 'ledger-org/mine');
    await seedTriageMission('msn_ledger', 'u_ledger', 'is:issue');

    await runTriagePlanner(
      'msn_ledger',
      searchReturning([
        issue('ledger-org/mine', 1),
        issue('denied-org/a', 2),
        issue('denied-org/b', 3),
      ]),
    );

    const payload = await plannerEmitted('msn_ledger');
    expect(payload?.deniedIssueCount).toBe(2);
    expect(payload?.deniedRepos).toEqual(['denied-org/a', 'denied-org/b']);
    // The repos actually planned are still reported separately and unchanged.
    expect(payload?.repos).toEqual(['ledger-org/mine']);
  });

  // FAIL CLOSED. A lookup that throws must not be reinterpreted as "allowed",
  // and must not leave half a plan behind — the throw happens before the
  // transaction opens, so the Mission is still draft with no Tasks.
  it('fails closed and writes nothing when the access lookup throws', async () => {
    await grantRepoAccess('u_closed', 'closed-org/mine');
    await seedTriageMission('msn_closed', 'u_closed', 'is:issue');
    mocks.userCanAccessRepo.mockImplementationOnce(async () => {
      throw new Error('installation lookup unavailable');
    });

    await expect(
      runTriagePlanner('msn_closed', searchReturning([issue('closed-org/mine', 1)])),
    ).rejects.toThrow('installation lookup unavailable');

    expect(await taskRepos('msn_closed')).toEqual([]);
    const [mission] = await db
      .select()
      .from(schema.missions)
      .where(eq(schema.missions.id, 'msn_closed'))
      .limit(1);
    expect(mission?.status).toBe('draft');
  });

  // The gate is the Mission OWNER's access, not "anyone's". Another account
  // holding the installation must not launder the attacker's query.
  it("does not accept another account's installation as the caller's access", async () => {
    await grantRepoAccess('victim', 'victim-org/private');
    await grantRepoAccess('u_launder', 'launder-org/own-repo');
    await seedTriageMission('msn_launder', 'u_launder', 'repo:victim-org/private is:issue');

    const result = await runTriagePlanner(
      'msn_launder',
      searchReturning([issue('victim-org/private', 1)]),
    );

    expect(result.taskCount).toBe(0);
    expect(await taskRepos('msn_launder')).toEqual([]);
  });

  it('checks each distinct repo once, not once per issue', async () => {
    await grantRepoAccess('u_batch', 'batch-org/mine');
    await seedTriageMission('msn_batch', 'u_batch', 'is:issue');

    await runTriagePlanner(
      'msn_batch',
      searchReturning([
        issue('batch-org/mine', 1),
        issue('batch-org/mine', 2),
        issue('batch-org/mine', 3),
      ]),
    );

    expect(mocks.userCanAccessRepo).toHaveBeenCalledTimes(1);
  });
});
