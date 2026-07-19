import { eq } from 'drizzle-orm';

import { missions } from '@forge/db';

import { db } from './db';

export type GateFlags = { aiReviewEnabled: boolean; selfVerifyEnabled: boolean };

/**
 * Resolve a mission's AI-review / self-verify gate flags for the CI and
 * verify passes. Issue-leaf missions are created with both flags hardcoded
 * false while repo settings only ever update the *container* row, so leaves
 * read through to their parent — making the settings toggle live for
 * existing and future leaves alike (same convention as the dispatcher
 * reading container.concurrencyCap). Standalone missions (no parent) use
 * their own flags; a missing parent falls back to the row's own flags.
 * Shared by ci.ts and verify.ts so the two can't drift.
 */
export async function resolveGateFlags(missionId: string): Promise<GateFlags> {
  const [row] = await db
    .select({
      aiReviewEnabled: missions.aiReviewEnabled,
      selfVerifyEnabled: missions.selfVerifyEnabled,
      parentMissionId: missions.parentMissionId,
    })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);
  if (!row) return { aiReviewEnabled: false, selfVerifyEnabled: false };

  if (row.parentMissionId) {
    const [parent] = await db
      .select({
        aiReviewEnabled: missions.aiReviewEnabled,
        selfVerifyEnabled: missions.selfVerifyEnabled,
      })
      .from(missions)
      .where(eq(missions.id, row.parentMissionId))
      .limit(1);
    if (parent) {
      return {
        aiReviewEnabled: parent.aiReviewEnabled,
        selfVerifyEnabled: parent.selfVerifyEnabled,
      };
    }
  }

  return { aiReviewEnabled: row.aiReviewEnabled, selfVerifyEnabled: row.selfVerifyEnabled };
}
