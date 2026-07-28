'use server';

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import { githubInstallationRepos, githubInstallations, missions } from '@forge/db';

import { db } from '@/lib/db';
import { withAuth } from '@/lib/with-auth';

/**
 * Internal control-flow signal for "no matching container" inside the
 * transaction below — thrown (never returned) so `db.transaction` rolls
 * back any partial write instead of committing one half of the pair. Never
 * escapes this module.
 */
class RepoSettingsNotFoundError extends Error {}

export type AutoMergePolicyInput = {
  enabled: boolean;
  maxAdditions?: number;
  maxDeletions?: number;
  maxFilesChanged?: number;
  requiredChecks?: string[];
  allowedPathPatterns?: string[];
  requireHumanApproval?: boolean;
};

export async function updateRepoSettings(
  containerId: string,
  input: {
    concurrencyCap: number;
    budgetUsd: number | null;
    aiReviewEnabled: boolean;
    selfVerifyEnabled: boolean;
    autoMerge: AutoMergePolicyInput;
    requirePlanApproval: boolean;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await withAuth();

  if (!Number.isInteger(input.concurrencyCap) || input.concurrencyCap < 1 || input.concurrencyCap > 100) {
    return { ok: false, error: 'Concurrency cap must be an integer between 1 and 100' };
  }
  if (input.budgetUsd !== null && (!Number.isInteger(input.budgetUsd) || input.budgetUsd < 1)) {
    return { ok: false, error: 'Budget must be a positive whole number of dollars, or blank' };
  }

  for (const [label, value] of [
    ['Max additions', input.autoMerge.maxAdditions],
    ['Max deletions', input.autoMerge.maxDeletions],
    ['Max files changed', input.autoMerge.maxFilesChanged],
  ] as const) {
    // M4: a cap of exactly 0 means "no diff may add/delete/change a single
    // line", which blocks every merge outright — not "no cap" (that's what
    // leaving the field blank, i.e. `undefined`, already means). This is the
    // exact footgun parse-optional-number.ts's own doc comment warns about:
    // it exists specifically so a blank box comes through as `undefined`,
    // not `0`. Reject 0 the same as any other invalid value rather than
    // silently accepting a policy that can never let a merge through.
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      return { ok: false, error: `${label} must be a positive whole number, or blank` };
    }
  }

  try {
    return await db.transaction(async (tx) => {
      // requirePlanApproval governs Mission *creation*, so it cannot live on
      // a Mission — it stays on the repo row, keyed by `workspaceRepo`.
      //
      // `workspaceRepo` — NOT `targetRepos[0]` — is the repo name here.
      // `targetRepos` is attacker-controlled: `createMissionSchema`
      // (missions.ts) lets any authenticated user create an ordinary
      // mission with an arbitrary `targetRepos: string[]`, validated only
      // against an `owner/repo` regex, with no check that the caller has
      // any installation covering that repo. Deriving the repo from it here
      // would let someone create their own throwaway mission naming a
      // victim's repo and flip that victim's plan-approval gate — the
      // ownership check below only proves the caller owns *a* mission row,
      // not that the row is a genuine repo container.
      //
      // `workspaceRepo` is written only by trusted server-side
      // container-creation code (workspace-mission.ts) and never appears in
      // createMissionSchema at all, so it cannot be smuggled in the same way.
      //
      // The WHERE below requires workspaceRepo IS NOT NULL, issueRef IS
      // NULL, and parentMissionId IS NULL — the same three conditions
      // isContainerMission (mission-shape.ts) uses to define a genuine
      // container. isNotNull(workspaceRepo) alone would not be enough: an
      // issue leaf mission also has workspaceRepo set (workspace-mission.ts,
      // getOrCreateIssueMission), so without also excluding leaves this
      // endpoint could be pointed at a leaf mission's id and write
      // repo-wide concurrency/budget fields onto that leaf's own row
      // instead of its container's. We mirror isContainerMission's three
      // conditions as SQL predicates here (rather than importing the
      // predicate itself) because it operates on an already-fetched row,
      // not as a composable WHERE clause, and the guarantee needs to be
      // enforced by the query itself so a non-container row is never
      // touched in the first place.
      const [updated] = await tx
        .update(missions)
        .set({
          concurrencyCap: input.concurrencyCap,
          budgetUsd: input.budgetUsd,
          aiReviewEnabled: input.aiReviewEnabled,
          selfVerifyEnabled: input.selfVerifyEnabled,
          autoMergePolicy: input.autoMerge,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(missions.id, containerId),
            eq(missions.userId, user.id),
            isNotNull(missions.workspaceRepo),
            isNull(missions.issueRef),
            isNull(missions.parentMissionId),
          ),
        )
        .returning();

      if (!updated) {
        throw new RepoSettingsNotFoundError();
      }

      const repo = updated.workspaceRepo;
      if (!repo) {
        // Structurally unreachable: isNotNull(missions.workspaceRepo) above
        // guarantees any row this UPDATE can touch has a non-null
        // workspaceRepo. This is deliberately a *different* thrown type
        // than RepoSettingsNotFoundError (not caught below, so it surfaces
        // as a real error instead of a graceful `{ ok: false }`) — landing
        // here means the WHERE guarantee above was violated, which is a
        // genuine invariant break, not an ordinary "not found". Silently
        // returning `{ ok: true }` here (the original bug) or swallowing
        // this into `{ ok: false }` would both hide that regression instead
        // of failing loudly. The transaction still rolls back the mission
        // write that already happened in this same `tx`.
        throw new Error('updateRepoSettings: matched a container with no workspaceRepo');
      }

      // Scope this write to an installation the ACTING user owns.
      //
      // The unique index on github_installation_repos is (installationId,
      // repo) — not repo alone (schema.ts) — so two different users' own,
      // legitimate installations can each hold a row for the very same repo
      // string (e.g. each independently connected the GitHub App to it).
      // Matching on `repo` alone, as this used to, would flip every such
      // row at once: acting on your own genuinely-covered repo would also
      // silently rewrite a stranger's row for that same repo name. The
      // mission-ownership check above only proves the container is this
      // user's own — it says nothing about whose installation row is being
      // written, since that row is looked up by bare repo name, not by
      // mission id.
      const ownInstallations = await tx
        .select({ id: githubInstallations.id })
        .from(githubInstallations)
        .where(eq(githubInstallations.userId, user.id));
      const ownInstallationIds = ownInstallations.map((row) => row.id);

      if (ownInstallationIds.length > 0) {
        await tx
          .update(githubInstallationRepos)
          .set({ repoPolicy: { requirePlanApproval: input.requirePlanApproval } })
          .where(
            and(
              eq(githubInstallationRepos.repo, repo),
              inArray(githubInstallationRepos.installationId, ownInstallationIds),
            ),
          );
      }

      return { ok: true } as const;
    });
  } catch (err) {
    if (err instanceof RepoSettingsNotFoundError) {
      return { ok: false, error: 'Repo settings not found' };
    }
    throw err;
  }
}
