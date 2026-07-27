import { eq } from '@forge/db/orm';

import { githubInstallationRepos, type RepoPolicy } from '@forge/db';

import { db } from './db';

export type { RepoPolicy };

/**
 * Gated by default. An unconfigured repo is one nobody has made a decision
 * about, and dispatching an agent is the less reversible of the two options.
 */
export const DEFAULT_REPO_POLICY: RepoPolicy = { requirePlanApproval: true };

export async function getRepoPolicy(repoFullName: string): Promise<RepoPolicy> {
  const [row] = await db
    .select({ policy: githubInstallationRepos.repoPolicy })
    .from(githubInstallationRepos)
    .where(eq(githubInstallationRepos.repo, repoFullName))
    .limit(1);
  return { ...DEFAULT_REPO_POLICY, ...(row?.policy ?? {}) };
}
