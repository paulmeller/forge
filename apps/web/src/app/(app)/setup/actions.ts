'use server';

import { randomUUID } from 'node:crypto';

import { eq } from '@forge/db/orm';

import { githubInstallationRepos, githubInstallations } from '@forge/db';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { createInstallationAccessToken, listInstallationRepositories } from '@/lib/github-app-auth';
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

  // `selectedRepos` is caller-supplied and this is a Server Action — a POST
  // endpoint reachable directly, without the repo-picker UI (repo-picker.tsx)
  // that normally builds this array from GitHub's own answer. Trusting it
  // verifies only that the caller owns *an* installation, not that the
  // installation was ever granted the repos named — anyone can install the
  // Forge GitHub App on their own account and then claim any repo string
  // here. And `userCanAccessRepo` (mission-defaults-db.ts) treats
  // `github_installation_repos` as ground truth for every downstream
  // repo-access gate (toggleNextMarker, workOnIssue, updateRepoSettings's
  // mission-ownership path) — so a bogus row here defeats all of them at
  // once. This must re-derive "what can this installation actually reach"
  // from GitHub itself, the same create-token-then-list-repos call
  // setup/page.tsx already makes to build the picker, and refuse anything
  // `selectedRepos` claims that GitHub doesn't corroborate.
  //
  // Reject the whole call rather than filtering to the allowed subset: this
  // is a directly-reachable write endpoint, so any repo outside GitHub's
  // answer is either an attack or a stale/corrupted client payload — both
  // are cases we want to fail loudly and atomically on, not partially apply.
  // Filtering would let a bad repo ride along in an otherwise-legitimate
  // batch and have everything else silently succeed, which is harder to
  // reason about and harder to notice went wrong.
  //
  // Fails CLOSED on top of that: unlike setup/page.tsx — a read path that
  // degrades to `ghRepos = null` and just renders an empty picker — this is
  // a write path. If GitHub can't be asked (app not configured, token
  // exchange fails, listInstallationRepositories errors), we must not fall
  // back to trusting the client's list; that fallback would BE the bypass.
  // Return an error and change nothing instead.
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    return { error: 'GitHub App is not configured on the server — cannot verify repo access' };
  }

  let ghRepos: string[];
  try {
    const token = await createInstallationAccessToken(installation.installationId, appId, privateKey);
    ghRepos = await listInstallationRepositories(token);
  } catch {
    return { error: 'Could not verify repo access with GitHub — try again' };
  }

  const ghRepoSet = new Set(ghRepos);
  const notGranted = selectedRepos.filter((r) => !ghRepoSet.has(r));
  if (notGranted.length > 0) {
    return { error: `Installation does not grant access to: ${notGranted.join(', ')}` };
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
    await db
      .insert(githubInstallationRepos)
      .values({
        id,
        installationId,
        repo,
        // Connecting a repo does not authorise dispatch (#40) — the operator
        // merges the proposed .forge/policy.yml first.
        onboardingState: 'pending_onboarding',
      })
      .onConflictDoNothing();
  }
  for (const row of toRemove) {
    await db.delete(githubInstallationRepos).where(eq(githubInstallationRepos.id, row.id));
  }

  return undefined;
}
