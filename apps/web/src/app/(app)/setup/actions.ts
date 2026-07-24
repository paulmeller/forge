'use server';

import { randomUUID } from 'node:crypto';

import { eq } from '@forge/db/orm';

import { githubInstallationRepos, githubInstallations } from '@forge/db';

import { db } from '@/lib/db';
import { withAuth } from '@/lib/with-auth';

export async function syncRepos(
  installationId: string,
  selectedRepos: string[],
): Promise<{ error?: string } | undefined> {
  const user = await withAuth();

  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, installationId))
    .limit(1);

  if (!installation || installation.userId !== user.id) {
    return { error: 'Installation not found' };
  }

  const existing = await db
    .select()
    .from(githubInstallationRepos)
    .where(eq(githubInstallationRepos.installationId, installationId));
  const existingRepoNames = new Set(existing.map((r) => r.repo));
  const selectedSet = new Set(selectedRepos);

  const toAdd = selectedRepos.filter((r) => !existingRepoNames.has(r));
  const toRemove = existing.filter((r) => !selectedSet.has(r.repo));

  for (const repo of toAdd) {
    const id = `ghr_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await db.insert(githubInstallationRepos).values({ id, installationId, repo }).onConflictDoNothing();
  }
  for (const row of toRemove) {
    await db.delete(githubInstallationRepos).where(eq(githubInstallationRepos.id, row.id));
  }

  return undefined;
}
