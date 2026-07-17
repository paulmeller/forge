'use server';

import { eq } from 'drizzle-orm';

import { missions } from '@forge/db';

import { db } from '@/lib/db';
import { withAuth } from '@/lib/with-auth';

export async function updateRepoSettings(
  containerId: string,
  input: {
    concurrencyCap: number;
    budgetUsd: number | null;
    aiReviewEnabled: boolean;
    selfVerifyEnabled: boolean;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  await withAuth();

  if (!Number.isInteger(input.concurrencyCap) || input.concurrencyCap < 1 || input.concurrencyCap > 100) {
    return { ok: false, error: 'Concurrency cap must be an integer between 1 and 100' };
  }
  if (input.budgetUsd !== null && (!Number.isInteger(input.budgetUsd) || input.budgetUsd < 1)) {
    return { ok: false, error: 'Budget must be a positive whole number of dollars, or blank' };
  }

  await db
    .update(missions)
    .set({
      concurrencyCap: input.concurrencyCap,
      budgetUsd: input.budgetUsd,
      aiReviewEnabled: input.aiReviewEnabled,
      selfVerifyEnabled: input.selfVerifyEnabled,
      updatedAt: new Date(),
    })
    .where(eq(missions.id, containerId));

  return { ok: true };
}
