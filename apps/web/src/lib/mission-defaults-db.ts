import { eq } from 'drizzle-orm';

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

  return rows.map((r) => r.repo).sort();
}
