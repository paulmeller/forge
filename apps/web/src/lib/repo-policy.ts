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

  // Fail closed. A security-relevant default must not be overridable by a
  // falsy-but-present value: only a literal `false` opts a repo out of plan
  // approval. Anything else — no row, no policy, a missing key, `null`, or
  // some other malformed value — is treated as gated. (A naive
  // `{ ...DEFAULT_REPO_POLICY, ...row?.policy }` spread would let e.g.
  // `{ requirePlanApproval: null }` silently ungate the repo.)
  if (row?.policy?.requirePlanApproval === false) {
    return { requirePlanApproval: false };
  }
  return DEFAULT_REPO_POLICY;
}
