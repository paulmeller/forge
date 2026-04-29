'use server';

import { randomUUID } from 'node:crypto';

import { eq } from '@forge/db/orm';

import { githubInstallationRepos, githubInstallations } from '@forge/db';

import { db } from '@/lib/db';
import { withAuth } from '@/lib/with-auth';

export async function connectRepos(
  installationId: string,
  repos: string[],
): Promise<{ error?: string } | undefined> {
  const user = await withAuth();

  // Verify this installation belongs to the user
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, installationId))
    .limit(1);

  if (!installation || installation.userId !== user.id) {
    return { error: 'Installation not found' };
  }

  // Insert repos (ignore duplicates)
  for (const repo of repos) {
    const id = `ghr_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await db
      .insert(githubInstallationRepos)
      .values({ id, installationId, repo })
      .onConflictDoNothing();
  }

  return undefined;
}
