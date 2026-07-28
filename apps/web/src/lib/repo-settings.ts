import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import { githubInstallationRepos, githubInstallations, missions, type Mission } from '@forge/db';

import { db } from './db';

/** Any drizzle handle the writes below can run against — the top-level `db` or a `db.transaction` callback's `tx`. */
type DbLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Find the caller's own container mission for `repo` — the sole ownership
 * gate for the /api/v1/repos/{owner}/{repo}/policy route (both the read and
 * the write). The route's only caller-supplied handle is the {owner}/{repo}
 * path segment, never a mission id, so this mirrors updateRepoSettings's
 * ownership predicate (settings-actions.ts) but keyed by repo instead.
 *
 * All five conditions matter:
 *  - `eq(userId, userId)` is the ownership check itself — this is what makes
 *    a mission "the caller's own", not merely "a mission that exists".
 *  - `eq(workspaceRepo, repo)` ties the row to the URL's repo. Once this
 *    matches, the row's own `workspaceRepo` is byte-identical to `repo` —
 *    but the row, not `repo`, is what every call site below must read the
 *    repo back from (see writeRepoPolicy's doc comment for why that
 *    distinction is load-bearing rather than decorative).
 *  - `isNotNull(workspaceRepo)` is implied by the equality above (a column
 *    can't equal a non-null string while being null) but is listed as its
 *    own condition anyway, for parity with settings-actions.ts's identical
 *    WHERE (there it is NOT implied, since that query matches by id).
 *  - `isNull(issueRef)` / `isNull(parentMissionId)` mirror isContainerMission
 *    (mission-shape.ts): a genuine container, never an issue leaf (which
 *    also carries `workspaceRepo` — see getOrCreateIssueMission,
 *    workspace-mission.ts) and never some other non-container row.
 *
 * Returns `null` for "no such repo", "not yours", and "exists but is a leaf,
 * not a container" alike — the /api/v1 route turns all three into the same
 * 404, never a distinguishable 403.
 */
export async function findOwnedContainerByRepo(userId: string, repo: string): Promise<Mission | null> {
  const [found] = await db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.userId, userId),
        eq(missions.workspaceRepo, repo),
        isNotNull(missions.workspaceRepo),
        isNull(missions.issueRef),
        isNull(missions.parentMissionId),
      ),
    )
    .limit(1);
  return found ?? null;
}

/**
 * Writes `requirePlanApproval` to `repo`'s github_installation_repos row(s),
 * scoped to installations `userId` owns — the exact write updateRepoSettings
 * performed inline, extracted so it's shared with the /api/v1 policy route
 * instead of the two drifting apart.
 *
 * `repo` must come from an already ownership-verified source — either
 * updateRepoSettings's own `UPDATE missions ... RETURNING` (keyed by a
 * containerId whose ownership *that* call just checked) or
 * findOwnedContainerByRepo's returned row (keyed by repo, ownership already
 * checked there). This function performs no ownership check of its own: it
 * trusts the caller. Re-deriving/re-checking ownership here — e.g. from a
 * caller-supplied repo string instead of a verified row — would reopen hop
 * two of the 2026-07-27 cross-account chain this whole module exists to
 * keep closed (a caller-supplied repo name flowing into a policy write), and
 * a *redundant* re-check here (keyed the same way the caller already keyed
 * it) would only risk masking a break in the caller's own check under
 * mutation testing without adding real protection — see this module's
 * callers for where the real, non-duplicated check lives in each case.
 *
 * The installation scoping below is a *different* property from mission
 * ownership: `github_installation_repos` is uniquely keyed by
 * (installationId, repo) — not repo alone (schema.ts) — so two different
 * users can each legitimately hold their own installation row for the
 * identical repo string. Matching on `repo` alone would flip every such row
 * at once.
 *
 * Returns HOW MANY rows were actually written. That number is not decorative:
 * mission ownership (a container mission exists for this repo) and
 * installation coverage (a `github_installation_repos` row exists under an
 * installation this user owns) are two different facts, and they diverge as
 * soon as the repo is removed from the installation, or the App is
 * uninstalled, after the container was created. When they diverge this
 * function legitimately writes NOTHING — and a caller that reported success
 * anyway would tell an operator their repo is gated when the stored policy
 * still says it is not, leaving agents dispatching without plan approval. The
 * count is the only signal that distinguishes "persisted" from "matched no
 * row", so callers must branch on it rather than assume.
 */
export async function writeRepoPolicy(
  txOrDb: DbLike,
  userId: string,
  repo: string,
  requirePlanApproval: boolean,
): Promise<number> {
  const ownInstallations = await txOrDb
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, userId));
  const ownInstallationIds = ownInstallations.map((row) => row.id);

  if (ownInstallationIds.length === 0) return 0;

  // `.returning()` rather than a driver-specific rowsAffected: the rows the
  // UPDATE matched are what "written" means here, and SQLite reports matched
  // rows even when the new value equals the old one — so re-asserting a policy
  // that is already set still counts as persisted, which is correct.
  const written = await txOrDb
    .update(githubInstallationRepos)
    .set({ repoPolicy: { requirePlanApproval } })
    .where(
      and(
        eq(githubInstallationRepos.repo, repo),
        inArray(githubInstallationRepos.installationId, ownInstallationIds),
      ),
    )
    .returning({ id: githubInstallationRepos.id });

  return written.length;
}
