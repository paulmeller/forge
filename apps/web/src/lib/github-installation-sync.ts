import { randomUUID } from 'node:crypto';

import { eq } from '@forge/db/orm';

import { githubInstallationRepos, githubInstallations } from '@forge/db';

import { db } from './db';
import { env } from './env';
import {
  createInstallationAccessToken,
  getInstallationAccount,
  listInstallationRepositories,
} from './github-app-auth';

/**
 * Pull the installation's real account + repo list from GitHub and persist
 * it — corrects the placeholder accountLogin/accountType the install
 * callback stores at insert time, and populates github_installation_repos
 * without requiring manual entry. Safe to call repeatedly: GitHub grants can
 * change (e.g. "Add more repos") without a new installation_id, and repo
 * inserts are onConflictDoNothing.
 */
export async function syncGithubInstallation(installationRowId: string): Promise<void> {
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, installationRowId))
    .limit(1);
  if (!installation) throw new Error(`Installation ${installationRowId} not found`);

  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not configured — cannot sync repos');
  }

  const [account, token] = await Promise.all([
    getInstallationAccount(installation.installationId, appId, privateKey),
    createInstallationAccessToken(installation.installationId, appId, privateKey),
  ]);

  const repos = await listInstallationRepositories(token);

  const now = new Date();
  await db
    .update(githubInstallations)
    .set({ accountLogin: account.login, accountType: account.type, updatedAt: now })
    .where(eq(githubInstallations.id, installation.id));

  for (const repo of repos) {
    const id = `ghr_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await db
      .insert(githubInstallationRepos)
      .values({ id, installationId: installation.id, repo })
      .onConflictDoNothing();
  }
}
