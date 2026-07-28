'use server';

import { and, eq } from 'drizzle-orm';

import { githubInstallationRepos, missions } from '@forge/db';

import { db } from '@/lib/db';
import { withAuth } from '@/lib/with-auth';

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
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      return { ok: false, error: `${label} must be a whole number of 0 or more, or blank` };
    }
  }

  const [updated] = await db
    .update(missions)
    .set({
      concurrencyCap: input.concurrencyCap,
      budgetUsd: input.budgetUsd,
      aiReviewEnabled: input.aiReviewEnabled,
      selfVerifyEnabled: input.selfVerifyEnabled,
      autoMergePolicy: input.autoMerge,
      updatedAt: new Date(),
    })
    .where(and(eq(missions.id, containerId), eq(missions.userId, user.id)))
    .returning();

  if (!updated) {
    return { ok: false, error: 'Repo settings not found' };
  }

  // requirePlanApproval governs Mission *creation*, so it cannot live on a
  // Mission — it stays on the repo row.
  //
  // The repo name is taken from the container we just ownership-checked, NOT
  // from a parameter. Accepting it from the caller would let someone pass
  // another account's repo alongside a container they legitimately own and
  // disable that account's plan-approval gate — the ownership check covers
  // the Mission, not an independent field beside it.
  const repo = (updated.targetRepos as string[] | null)?.[0];
  if (repo) {
    await db
      .update(githubInstallationRepos)
      .set({ repoPolicy: { requirePlanApproval: input.requirePlanApproval } })
      .where(eq(githubInstallationRepos.repo, repo));
  }

  return { ok: true };
}
