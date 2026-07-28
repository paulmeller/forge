import { eq } from 'drizzle-orm';

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

  return (row.autoMergePolicy as AutoMergePolicy | null) ?? null;
}
