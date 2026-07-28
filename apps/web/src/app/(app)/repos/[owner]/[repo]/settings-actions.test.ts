import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { AutoMergePolicy, RepoPolicy } from '@forge/db';

import type { AutoMergePolicyInput } from './settings-actions';

const DB_FILE = `/tmp/forge-repo-settings-actions-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

const mocks = vi.hoisted(() => ({
  withAuth: vi.fn(),
}));
vi.mock('@/lib/with-auth', () => ({ withAuth: mocks.withAuth }));

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let updateRepoSettings: typeof import('./settings-actions').updateRepoSettings;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db as never, {
    migrationsFolder: resolve(__dirname, '../../../../../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ updateRepoSettings } = await import('./settings-actions'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

async function seedMission(over: {
  id: string;
  userId?: string;
  targetRepos?: string[] | null;
  /** Set to mark this row a genuine repo container (see workspace-mission.ts). */
  workspaceRepo?: string | null;
  /** Set to make this row an issue leaf instead of a container. */
  issueRef?: string | null;
  parentMissionId?: string | null;
}) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id: over.id,
    userId: over.userId ?? 'u1',
    name: 'Test container',
    goal: 'container',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    targetRepos: over.targetRepos === undefined ? ['a/b'] : over.targetRepos,
    workspaceRepo: over.workspaceRepo ?? null,
    issueRef: over.issueRef ?? null,
    parentMissionId: over.parentMissionId ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

/** Inserts a github_installation_repos row (and its parent installation) for `repo`. */
async function seedRepoRow(repo: string, policy: RepoPolicy | null) {
  const now = new Date();
  const installationId = `ghi_${repo.replaceAll('/', '_')}`;
  await db.insert(schema.githubInstallations).values({
    id: installationId,
    userId: 'u1',
    installationId: Math.floor(Math.random() * 1_000_000),
    accountLogin: repo.split('/')[0] ?? 'acme',
    accountType: 'Organization',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.githubInstallationRepos).values({
    id: `ghr_${repo.replaceAll('/', '_')}`,
    installationId,
    repo,
    repoPolicy: policy,
    createdAt: now,
  });
}

async function missionRow(id: string) {
  const [row] = await db.select().from(schema.missions).where(eq(schema.missions.id, id)).limit(1);
  if (!row) throw new Error(`no such mission: ${id}`);
  return row;
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

function validInput(overrides: {
  concurrencyCap?: number;
  budgetUsd?: number | null;
  aiReviewEnabled?: boolean;
  selfVerifyEnabled?: boolean;
  autoMerge?: AutoMergePolicyInput;
  requirePlanApproval?: boolean;
}) {
  return {
    concurrencyCap: 5,
    budgetUsd: null,
    aiReviewEnabled: false,
    selfVerifyEnabled: false,
    autoMerge: { enabled: false } as AutoMergePolicyInput,
    requirePlanApproval: true,
    ...overrides,
  };
}

describe('updateRepoSettings — policies', () => {
  beforeEach(async () => {
    mocks.withAuth.mockReset();
    mocks.withAuth.mockResolvedValue({ id: 'u1', name: 'Owner', email: 'u1@x.com' });
    // github_installations cascades to github_installation_repos.
    await db.delete(schema.githubInstallations);
    await db.delete(schema.missions);
    await seedMission({ id: 'm_container', userId: 'u1', targetRepos: ['a/b'], workspaceRepo: 'a/b' });
    await seedMission({
      id: 'm_other_user',
      userId: 'someone_else',
      targetRepos: ['other/repo'],
      workspaceRepo: 'other/repo',
    });
    await seedRepoRow('a/b', null);
    await seedRepoRow('other/repo', { requirePlanApproval: true });
  });

  it('writes the auto-merge policy to the container mission', async () => {
    const res = await updateRepoSettings(
      'm_container',
      validInput({
        autoMerge: { enabled: true, maxAdditions: 50, requiredChecks: ['build'] },
      }),
    );
    expect(res).toEqual({ ok: true });
    const m = await missionRow('m_container');
    expect(m.autoMergePolicy as AutoMergePolicy).toMatchObject({
      enabled: true,
      maxAdditions: 50,
      requiredChecks: ['build'],
    });
  });

  it('writes requirePlanApproval to the repo row named by the container, not the mission', async () => {
    // m_container is seeded with targetRepos: ['a/b'].
    await updateRepoSettings('m_container', validInput({ requirePlanApproval: false }));
    expect((await repoRow('a/b')).repoPolicy).toEqual({ requirePlanApproval: false });
  });

  it("cannot be steered at another account's repo", async () => {
    // The repo is derived from the ownership-checked container, so there is
    // no caller-supplied field that selects which repo row is written. The
    // input type has no `repo` field at all — but that alone only proves a
    // *type-level* guarantee, which a later edit could quietly widen. Smuggle
    // a `repo` property past the type (as the client's raw POST body could)
    // to prove the *implementation* ignores it too, not just the signature.
    await seedRepoRow('victim/secret', { requirePlanApproval: true });
    const smuggled = { ...validInput({ requirePlanApproval: false }), repo: 'victim/secret' };
    await updateRepoSettings('m_container', smuggled as never);
    expect((await repoRow('victim/secret')).repoPolicy).toEqual({ requirePlanApproval: true });
  });

  it('omits empty lists rather than storing []', async () => {
    // "unset" and "empty" must not diverge: an empty allow-list would
    // otherwise read as "no path may change", blocking everything.
    await updateRepoSettings(
      'm_container',
      validInput({
        autoMerge: { enabled: true, requiredChecks: undefined, allowedPathPatterns: undefined },
      }),
    );
    const p = (await missionRow('m_container')).autoMergePolicy as AutoMergePolicy;
    expect(p).not.toHaveProperty('requiredChecks');
    expect(p).not.toHaveProperty('allowedPathPatterns');
  });

  it("refuses another user's container and writes nothing", async () => {
    // requirePlanApproval: false deliberately disagrees with the seeded
    // repo row's true, so a write that slips out ahead of (or despite) the
    // ownership check flips a value we can observe, not one that already
    // matches by coincidence.
    const res = await updateRepoSettings('m_other_user', validInput({ requirePlanApproval: false }));
    expect(res).toEqual({ ok: false, error: 'Repo settings not found' });
    expect((await missionRow('m_other_user')).autoMergePolicy).toBeNull();
    expect((await repoRow('other/repo')).repoPolicy).toEqual({ requirePlanApproval: true });
  });

  it('rejects a negative diff cap', async () => {
    const res = await updateRepoSettings(
      'm_container',
      validInput({ autoMerge: { enabled: true, maxAdditions: -1 } }),
    );
    expect(res.ok).toBe(false);
  });
});

describe('updateRepoSettings — cross-account attack via targetRepos', () => {
  beforeEach(async () => {
    mocks.withAuth.mockReset();
    await db.delete(schema.githubInstallations);
    await db.delete(schema.missions);
  });

  it("an attacker's ordinary mission naming a victim's repo in targetRepos cannot flip the victim's plan-approval gate", async () => {
    // Victim: a github_installation_repos row owned by a different user,
    // with requirePlanApproval already true.
    await seedRepoRow('victim-org/victim-repo', { requirePlanApproval: true });
    await db
      .update(schema.githubInstallations)
      .set({ userId: 'victim' })
      .where(eq(schema.githubInstallations.id, 'ghi_victim-org_victim-repo'));

    // Attacker: authenticated as themself, creates an ORDINARY mission (no
    // workspaceRepo — exactly what createMissionSchema produces) whose
    // targetRepos names the victim's repo. This is the exact shape
    // createMissionAction would insert for any authenticated caller.
    await seedMission({
      id: 'm_attacker_ordinary',
      userId: 'attacker',
      targetRepos: ['victim-org/victim-repo'],
      // workspaceRepo intentionally omitted (null) — this is not a container.
    });

    mocks.withAuth.mockResolvedValue({ id: 'attacker', name: 'Attacker', email: 'attacker@x.com' });

    const res = await updateRepoSettings(
      'm_attacker_ordinary',
      validInput({ requirePlanApproval: false }),
    );

    expect(res).toEqual({ ok: false, error: 'Repo settings not found' });
    // The victim's plan-approval gate must be untouched.
    expect((await repoRow('victim-org/victim-repo')).repoPolicy).toEqual({
      requirePlanApproval: true,
    });
    // Nor should the attacker's own ordinary mission have picked up
    // container-only fields as a side effect.
    expect((await missionRow('m_attacker_ordinary')).autoMergePolicy).toBeNull();
  });

  it('derives the repo from workspaceRepo, not targetRepos, even when a genuine container row diverges', async () => {
    // A real container (workspaceRepo set, issueRef/parentMissionId null)
    // legitimately owned by the attacker — passes the WHERE guard on its
    // own merits. targetRepos is crafted to diverge from workspaceRepo
    // (something the app's own code paths never produce — workspace-mission.ts
    // always sets both to the same repo — but isolating exactly which
    // field the repo write is keyed on doesn't depend on that: this pins
    // the derivation source independently of the container/WHERE check).
    await seedRepoRow('attacker-org/attacker-repo', { requirePlanApproval: true });
    await seedRepoRow('victim-org/victim-repo', { requirePlanApproval: true });
    await seedMission({
      id: 'm_attacker_container',
      userId: 'attacker',
      workspaceRepo: 'attacker-org/attacker-repo',
      targetRepos: ['victim-org/victim-repo'],
    });

    mocks.withAuth.mockResolvedValue({ id: 'attacker', name: 'Attacker', email: 'attacker@x.com' });

    const res = await updateRepoSettings(
      'm_attacker_container',
      validInput({ requirePlanApproval: false }),
    );

    expect(res).toEqual({ ok: true });
    // Only the mission's own (workspaceRepo) repo may change...
    expect((await repoRow('attacker-org/attacker-repo')).repoPolicy).toEqual({
      requirePlanApproval: false,
    });
    // ...never the repo named in targetRepos.
    expect((await repoRow('victim-org/victim-repo')).repoPolicy).toEqual({
      requirePlanApproval: true,
    });
  });

  it('also rejects an attacker-owned issue-leaf mission (workspaceRepo set, but not a container)', async () => {
    // A leaf mission also carries workspaceRepo (see workspace-mission.ts,
    // getOrCreateIssueMission) — here pointed at the attacker's own repo,
    // simulating an attacker who has a real, legitimate leaf mission but
    // tries to use its id as if it were a container.
    await seedMission({
      id: 'm_attacker_leaf',
      userId: 'attacker',
      targetRepos: ['attacker-org/attacker-repo'],
      workspaceRepo: 'attacker-org/attacker-repo',
      issueRef: 'attacker-org/attacker-repo#1',
      parentMissionId: 'm_attacker_container',
    });

    mocks.withAuth.mockResolvedValue({ id: 'attacker', name: 'Attacker', email: 'attacker@x.com' });

    const res = await updateRepoSettings(
      'm_attacker_leaf',
      validInput({ requirePlanApproval: false }),
    );

    expect(res).toEqual({ ok: false, error: 'Repo settings not found' });
  });
});
