import { and, eq, type SQL } from '@forge/db/orm';

import { githubInstallationRepos, githubInstallations, type RepoPolicy } from '@forge/db';

import { db } from './db';

export type { RepoPolicy };

/**
 * Gated by default. An unconfigured repo is one nobody has made a decision
 * about, and dispatching an agent is the less reversible of the two options.
 */
export const DEFAULT_REPO_POLICY: RepoPolicy = { requirePlanApproval: true };

/**
 * `repoPolicy` is written per-installation (settings-actions.ts scopes the
 * write to an installation the acting user owns — the unique index on
 * github_installation_repos is (installationId, repo), not repo alone, so
 * two different installations can legitimately each hold a row for the
 * identical repo string). The read has to be scoped the same way, or one
 * tenant's installation can ungate another tenant's repo of the same name.
 *
 * `scope` narrows which installation's row is read. There are two shapes
 * because there are two kinds of caller:
 *  - An interactive caller (the repo Settings page) has a signed-in user but
 *    no installation id up front — `getRepoPolicyForUser` resolves against
 *    installations THAT USER owns, the same condition `userCanAccessRepo`
 *    (mission-defaults-db.ts) and settings-actions.ts's write both use.
 *  - dispatch-from-github.ts has no interactive user at all — `getRepoPolicy`
 *    resolves against GitHub's own numeric installation id, the
 *    `installation.id` field GitHub includes in every signed, verified
 *    webhook payload. See that module's doc comment on
 *    `GithubDispatchInput.installationId` for why that is safe.
 * Neither ever falls back to an unscoped, cross-tenant read.
 */
async function resolveRepoPolicy(repoFullName: string, scope: SQL): Promise<RepoPolicy> {
  const [row] = await db
    .select({ policy: githubInstallationRepos.repoPolicy })
    .from(githubInstallationRepos)
    .innerJoin(
      githubInstallations,
      eq(githubInstallationRepos.installationId, githubInstallations.id),
    )
    .where(and(eq(githubInstallationRepos.repo, repoFullName), scope))
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

/**
 * Scoped by GitHub's own numeric installation id (`github_installations.
 * installationId`, globally unique) — for dispatch-from-github.ts, which has
 * no interactive session to resolve "whose installation" any other way.
 */
export async function getRepoPolicy(
  repoFullName: string,
  installationId: number,
): Promise<RepoPolicy> {
  return resolveRepoPolicy(repoFullName, eq(githubInstallations.installationId, installationId));
}

/**
 * Scoped by which installations the given user owns — for the interactive
 * repo Settings page, which has a signed-in user but no installation id.
 */
export async function getRepoPolicyForUser(
  repoFullName: string,
  userId: string,
): Promise<RepoPolicy> {
  return resolveRepoPolicy(repoFullName, eq(githubInstallations.userId, userId));
}
