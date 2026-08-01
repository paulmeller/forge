import { and, eq, isNull } from 'drizzle-orm';

import { missions, type AutoMergePolicy } from '@forge/db';

import { db } from '@/lib/db';

/**
 * Resolve a Mission's auto-merge policy. Issue-leaf missions are created
 * without one while repo settings only ever update the *container* row, so
 * leaves read through to their parent — making the settings toggle live for
 * existing and future leaves alike. Standalone missions (no parent) use
 * their own; a missing parent falls back to the row's own.
 *
 * Deliberately a live lookup rather than a value copied at creation:
 * enabling auto-merge on a repo must free the Tasks already sitting in
 * `ready_to_merge`, which is exactly the population a copy would strand.
 *
 * Same convention as resolveGateFlags in gate-flags.ts. Shared by
 * auto-merge.ts and reconciler.ts so the two cannot disagree about whether
 * a Task is merge-eligible.
 */
export async function resolveAutoMergePolicy(
  missionId: string,
): Promise<AutoMergePolicy | null> {
  const [row] = await db
    .select({
      autoMergePolicy: missions.autoMergePolicy,
      parentMissionId: missions.parentMissionId,
      workspaceRepo: missions.workspaceRepo,
      targetRepos: missions.targetRepos,
      userId: missions.userId,
    })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);
  if (!row) return null;

  if (row.parentMissionId) {
    const [parent] = await db
      .select({ autoMergePolicy: missions.autoMergePolicy })
      .from(missions)
      .where(eq(missions.id, row.parentMissionId))
      .limit(1);
    if (parent) return (parent.autoMergePolicy as AutoMergePolicy | null) ?? null;
  }

  // @forge missions (dispatchFromGithub) are single-repo, standalone rows:
  // they carry targetRepos but no workspaceRepo or parentMissionId, so
  // there's no container id to follow above. They still belong to a repo,
  // so find that repo's container the same way updateRepoSettings writes to
  // it — by workspaceRepo — rather than leaving them stuck reading their own
  // (permanently unset) column.
  if (!row.workspaceRepo && row.targetRepos?.length === 1) {
    const [container] = await db
      .select({ autoMergePolicy: missions.autoMergePolicy })
      .from(missions)
      .where(
        and(
          // Scoped to the SAME OWNER. Unlike the parentMissionId path above —
          // a direct reference the mission already holds — this finds a
          // container by repo NAME, which two different users can both have
          // for the same repo. Without this filter an @forge mission could
          // inherit a stranger's auto-merge policy and merge on a setting its
          // own owner never enabled.
          eq(missions.userId, row.userId),
          eq(missions.workspaceRepo, row.targetRepos[0]!),
          isNull(missions.issueRef),
          isNull(missions.parentMissionId),
        ),
      )
      .limit(1);
    if (container) return (container.autoMergePolicy as AutoMergePolicy | null) ?? null;
  }

  return (row.autoMergePolicy as AutoMergePolicy | null) ?? null;
}
