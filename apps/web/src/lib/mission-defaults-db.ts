import { and, desc, eq } from 'drizzle-orm';

import { githubInstallationRepos, githubInstallations } from '@forge/db';

import { db } from './db';
import { env } from './env';
import { pickMissionDefaults, type MissionDefaults } from './mission-defaults';

/** Resolve composer defaults: the user's Setup installation, then env. */
export async function resolveMissionDefaults(userId: string): Promise<MissionDefaults> {
  const [installation] = await db
    .select({
      installationId: githubInstallations.installationId,
      agentId: githubInstallations.agentId,
      githubVaultId: githubInstallations.githubVaultId,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, userId))
    .orderBy(desc(githubInstallations.createdAt))
    .limit(1);

  return pickMissionDefaults(installation, {
    agentId: env.FORGE_DEFAULT_AGENT_ID,
    githubVaultId: env.FORGE_DEFAULT_GITHUB_VAULT_ID,
  });
}

/** Repos the user's GitHub App installation can reach, for the repo picker. */
export async function listUserRepos(userId: string): Promise<string[]> {
  const rows = await db
    .select({ repo: githubInstallationRepos.repo })
    .from(githubInstallationRepos)
    .innerJoin(
      githubInstallations,
      eq(githubInstallationRepos.installationId, githubInstallations.id),
    )
    .where(eq(githubInstallations.userId, userId));

  return [...new Set(rows.map((r) => r.repo))].sort();
}

/**
 * Does this user's GitHub App installation actually cover `repo`?
 *
 * This is the authorization gate every entry point that takes a
 * caller-supplied `repo` string must pass before it may act on that repo —
 * in particular before minting or touching a Mission whose `workspaceRepo`
 * names it (see workspace-mission.ts's getOrCreateWorkspaceMission /
 * getOrCreateIssueMission). Without this, an authenticated user could name
 * any repo string — one they have no installation for at all — and the
 * Mission that gets created is still structurally a genuine container
 * (owned by them, workspaceRepo set), passing every downstream ownership
 * check even though they never had any real access to that repo.
 *
 * Same join `listUserRepos` already does (github_installation_repos ->
 * github_installations, scoped to this user) — reused here rather than
 * duplicated so "does the user have this repo" is answered by exactly one
 * query shape across the app, not two that could quietly drift apart.
 *
 * Callers must treat `false` identically whether `repo` belongs to someone
 * else or doesn't exist at all — the query can't distinguish the two, and
 * it must not: leaking existence would let a caller enumerate other
 * accounts' private repos one guess at a time.
 */
export async function userCanAccessRepo(userId: string, repo: string): Promise<boolean> {
  const [row] = await db
    .select({ repo: githubInstallationRepos.repo })
    .from(githubInstallationRepos)
    .innerJoin(
      githubInstallations,
      eq(githubInstallationRepos.installationId, githubInstallations.id),
    )
    .where(and(eq(githubInstallations.userId, userId), eq(githubInstallationRepos.repo, repo)))
    .limit(1);

  return row !== undefined;
}
