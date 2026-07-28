import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { RepoPolicy } from '@forge/db';

const DB_FILE = `/tmp/forge-v1-repo-policy-route-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({ apiAuth: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ apiAuth: mocks.apiAuth }));

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let GET: typeof import('./route').GET;
let PUT: typeof import('./route').PUT;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ GET, PUT } = await import('./route'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

afterEach(() => {
  mocks.apiAuth.mockReset();
});

beforeEach(async () => {
  // github_installations cascades to github_installation_repos.
  await db.delete(schema.githubInstallations);
  await db.delete(schema.missions);
});

function authAs(id: string) {
  mocks.apiAuth.mockResolvedValueOnce([{ id, name: id, email: `${id}@x.com` }, null]);
}

function params(owner: string, repo: string) {
  return { params: Promise.resolve({ owner, repo }) };
}

function putRequest(body: unknown) {
  return new Request('http://x', { method: 'PUT', body: JSON.stringify(body) });
}

/** A genuine container mission (workspaceRepo set, no issueRef/parentMissionId) — see mission-shape.ts's isContainerMission. */
async function seedContainer(over: {
  id: string;
  userId: string;
  workspaceRepo: string;
  issueRef?: string | null;
  parentMissionId?: string | null;
}) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id: over.id,
    userId: over.userId,
    name: 'Test container',
    goal: 'container',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'triage',
    webhookSecret: 'secret',
    targetRepos: [over.workspaceRepo],
    workspaceRepo: over.workspaceRepo,
    issueRef: over.issueRef ?? null,
    parentMissionId: over.parentMissionId ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

/** An installation + covered repo row, owned by `userId`. */
async function seedInstallationRepo(
  userId: string,
  installationDbId: string,
  repo: string,
  policy: RepoPolicy | null = null,
) {
  const now = new Date();
  await db.insert(schema.githubInstallations).values({
    id: installationDbId,
    userId,
    installationId: Math.floor(Math.random() * 1_000_000_000),
    accountLogin: repo.split('/')[0] ?? 'acme',
    accountType: 'Organization',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubInstallationRepos).values({
    id: `ghr_${installationDbId}_${repo.replaceAll('/', '_')}`,
    installationId: installationDbId,
    repo,
    repoPolicy: policy,
    createdAt: now,
  });
}

async function repoRow(repo: string) {
  const [row] = await db
    .select()
    .from(schema.githubInstallationRepos)
    .where(eq(schema.githubInstallationRepos.repo, repo))
    .limit(1);
  if (!row) throw new Error(`no such repo row: ${repo}`);
  return row;
}

describe('GET /api/v1/repos/[owner]/[repo]/policy', () => {
  it("reads the caller's own repo policy", async () => {
    await seedContainer({ id: 'm_mine', userId: 'u1', workspaceRepo: 'acme/api' });
    await seedInstallationRepo('u1', 'ghi_u1', 'acme/api', { requirePlanApproval: false });
    authAs('u1');

    const res = await GET(new Request('http://x'), params('acme', 'api'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requirePlanApproval: false });
  });

  it('defaults to gated (requirePlanApproval: true) when no policy row exists yet', async () => {
    await seedContainer({ id: 'm_default', userId: 'u1', workspaceRepo: 'acme/unset' });
    authAs('u1');

    const res = await GET(new Request('http://x'), params('acme', 'unset'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requirePlanApproval: true });
  });

  it("404s for a repo the caller has no container mission for — never distinguishable from another account's", async () => {
    await seedContainer({ id: 'm_theirs', userId: 'other', workspaceRepo: 'acme/theirs' });
    authAs('attacker_1');

    const res = await GET(new Request('http://x'), params('acme', 'theirs'));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('404s for a repo with no container mission at all', async () => {
    authAs('u1');

    const res = await GET(new Request('http://x'), params('acme', 'does-not-exist'));

    expect(res.status).toBe(404);
  });
});

describe('PUT /api/v1/repos/[owner]/[repo]/policy', () => {
  it("sets requirePlanApproval on the caller's own repo", async () => {
    await seedContainer({ id: 'm_mine', userId: 'u1', workspaceRepo: 'acme/api' });
    await seedInstallationRepo('u1', 'ghi_u1', 'acme/api', { requirePlanApproval: true });
    authAs('u1');

    const res = await PUT(putRequest({ requirePlanApproval: false }), params('acme', 'api'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requirePlanApproval: false });
    expect((await repoRow('acme/api')).repoPolicy).toEqual({ requirePlanApproval: false });
  });

  it('400s on an invalid body', async () => {
    await seedContainer({ id: 'm_mine', userId: 'u1', workspaceRepo: 'acme/api' });
    authAs('u1');

    const res = await PUT(putRequest({ requirePlanApproval: 'nope' }), params('acme', 'api'));

    expect(res.status).toBe(400);
  });

  it("404s and writes nothing for a repo the caller has no container mission for", async () => {
    await seedContainer({ id: 'm_theirs', userId: 'other', workspaceRepo: 'acme/theirs' });
    await seedInstallationRepo('other', 'ghi_other', 'acme/theirs', { requirePlanApproval: true });
    authAs('attacker_1');

    const res = await PUT(putRequest({ requirePlanApproval: false }), params('acme', 'theirs'));

    expect(res.status).toBe(404);
    expect((await repoRow('acme/theirs')).repoPolicy).toEqual({ requirePlanApproval: true });
  });

  /**
   * Owning a container mission and holding an installation row for the repo
   * are two DIFFERENT facts. The ownership gate keys on the container; the
   * write is scoped to (repo, installationId IN own). They diverge as soon as
   * the repo is removed from the installation, or the App uninstalled, after
   * the container was created — and then the UPDATE matches zero rows.
   *
   * The route used to return `ok({ requirePlanApproval })` unconditionally
   * here: a 200 asserting a value that was never persisted.
   */
  it('404s instead of reporting success when the caller owns the container but no installation row covers the repo', async () => {
    await seedContainer({ id: 'm_no_install', userId: 'u1', workspaceRepo: 'acme/orphan' });
    // No installation row for acme/orphan at all.
    authAs('u1');

    const res = await PUT(putRequest({ requirePlanApproval: true }), params('acme', 'orphan'));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  /**
   * The specific harmful case: a real, PRE-EXISTING `{requirePlanApproval:
   * false}` row survives under an installation the caller no longer owns. The
   * write no-ops, so the repo stays ungated. Reporting 200 here tells the
   * operator plan approval is required while agents keep dispatching without
   * it — the row assertion is what pins that, not just the status code.
   */
  it('does not report success when the surviving policy row belongs to an installation the caller no longer owns', async () => {
    const repo = 'acme/left-behind';
    await seedContainer({ id: 'm_stale', userId: 'u1', workspaceRepo: repo });
    await seedInstallationRepo('former_owner', 'ghi_former', repo, { requirePlanApproval: false });
    authAs('u1');

    const res = await PUT(putRequest({ requirePlanApproval: true }), params('acme', 'left-behind'));

    expect(res.status).not.toBe(200);
    expect(res.status).toBe(404);
    // The stored policy is still the ungated one the operator believed they
    // had just changed.
    expect((await repoRow(repo)).repoPolicy).toEqual({ requirePlanApproval: false });
  });

  it('404s and writes nothing for a repo with no container mission at all', async () => {
    authAs('u1');

    const res = await PUT(putRequest({ requirePlanApproval: false }), params('acme', 'ghost'));

    expect(res.status).toBe(404);
  });

  // The five-hop cross-account chain closed 2026-07-27: hop two was exactly
  // this endpoint's write. This is the scenario that makes the container
  // lookup's ownership check load-bearing rather than decorative — the
  // attacker's OWN installation genuinely covers the same repo STRING as the
  // victim's (github_installation_repos is keyed by (installationId, repo),
  // not repo alone — schema.ts — so this overlap is a legitimate situation,
  // not a data bug), so a write scoped ONLY by "the acting user's own
  // installations" (no container-mission check) would still find a row to
  // flip. The container-ownership lookup is what must also refuse it.
  it("refuses to flip an attacker's own installation row for a repo whose container mission belongs to someone else", async () => {
    const repo = 'shared-name/shared-name';
    await seedInstallationRepo('attacker', 'ghi_attacker', repo, { requirePlanApproval: true });
    await seedInstallationRepo('victim', 'ghi_victim', repo, { requirePlanApproval: true });
    await seedContainer({ id: 'm_victim_container', userId: 'victim', workspaceRepo: repo });
    // Attacker has no container mission for `repo` at all.
    authAs('attacker');

    const [owner, repoName] = repo.split('/') as [string, string];
    const res = await PUT(putRequest({ requirePlanApproval: false }), params(owner, repoName));

    expect(res.status).toBe(404);
    const rows = await db
      .select()
      .from(schema.githubInstallationRepos)
      .where(eq(schema.githubInstallationRepos.repo, repo));
    const byInstallation = new Map(rows.map((r) => [r.installationId, r.repoPolicy]));
    expect(byInstallation.get('ghi_attacker')).toEqual({ requirePlanApproval: true });
    expect(byInstallation.get('ghi_victim')).toEqual({ requirePlanApproval: true });
  });

  it('also rejects an attacker-owned issue-leaf mission (workspaceRepo set, but not a container)', async () => {
    await seedContainer({ id: 'm_attacker_container', userId: 'attacker', workspaceRepo: 'acme/repo' });
    await seedContainer({
      id: 'm_attacker_leaf',
      userId: 'attacker',
      workspaceRepo: 'acme/repo',
      issueRef: 'acme/repo#1',
      parentMissionId: 'm_attacker_container',
    });
    // Delete the real container so only the leaf remains — proves the leaf
    // itself can never satisfy the lookup, not merely that the container
    // wins when both exist.
    await db.delete(schema.missions).where(eq(schema.missions.id, 'm_attacker_container'));
    await seedInstallationRepo('attacker', 'ghi_attacker', 'acme/repo', { requirePlanApproval: true });
    authAs('attacker');

    const res = await PUT(putRequest({ requirePlanApproval: false }), params('acme', 'repo'));

    expect(res.status).toBe(404);
    expect((await repoRow('acme/repo')).repoPolicy).toEqual({ requirePlanApproval: true });
  });
});
