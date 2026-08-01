import { eq } from 'drizzle-orm';

import { githubInstallationRepos } from '@forge/db';

import { db } from '@/lib/db';
import { getOctokitClient } from '@/lib/octokit';
import { policyFileTemplate } from '@/lib/policy-file';
import { POLICY_FILE_PATH, clearRepoPolicyCache, resolveRepoPolicy } from '@/lib/repo-policy';

type Logger = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };

export type OnboardingResult = {
  reposChecked: number;
  prsOpened: number;
  activated: number;
  regated: number;
};

const BRANCH = 'forge/onboarding';

/**
 * The consent gate (#40).
 *
 * A newly connected repo is `pending_onboarding`: Forge proposes
 * `.forge/policy.yml` by pull request and dispatches nothing until it lands.
 * Merging the PR IS the consent — there is no second switch to flip.
 *
 * The reverse also holds: an active repo whose file has been deleted returns
 * to pending. Deleting the file that authorises autonomous work should stop
 * autonomous work, rather than silently reverting to database policy.
 */
export async function runOnboarding(log: Logger): Promise<OnboardingResult> {
  // The policy cache is per-tick and this stage reads the same files the
  // later stages will; clear it so an activation decision cannot be made on
  // a resolution cached before the operator merged.
  clearRepoPolicyCache();

  const repos = await db.select().from(githubInstallationRepos);
  let prsOpened = 0;
  let activated = 0;
  let regated = 0;

  for (const row of repos) {
    const repo = row.repo as string;
    const installationId = row.installationId as string;
    let resolution;
    try {
      resolution = await resolveRepoPolicy(repo, installationId);
    } catch (err) {
      // Could not tell. Change nothing: re-gating an active repo on a
      // transient GitHub failure would halt a working fleet.
      log.warn({ repo, err: err instanceof Error ? err.message : String(err) }, 'onboarding:resolve_failed');
      continue;
    }

    const hasValidFile = resolution.source === 'file';

    if (row.onboardingState === 'pending_onboarding') {
      if (hasValidFile) {
        await db
          .update(githubInstallationRepos)
          .set({ onboardingState: 'active' })
          .where(eq(githubInstallationRepos.id, row.id as string));
        activated += 1;
        log.info({ repo }, 'onboarding:activated');
        continue;
      }
      if (!row.onboardingPrUrl) {
        const url = await proposePolicyFile(repo, log);
        if (url) {
          await db
            .update(githubInstallationRepos)
            .set({ onboardingPrUrl: url })
            .where(eq(githubInstallationRepos.id, row.id as string));
          prsOpened += 1;
        }
      }
      continue;
    }

    // Active. Only a genuine absence re-gates: an invalid file already blocks
    // dispatch through resolveRepoPolicy without unwinding the operator's
    // consent — re-gating on it too would be a second path to the same
    // outcome, and the narrower rule is the safer one to get wrong.
    if (resolution.source === 'default' || resolution.source === 'database') {
      await db
        .update(githubInstallationRepos)
        .set({ onboardingState: 'pending_onboarding', onboardingPrUrl: null })
        .where(eq(githubInstallationRepos.id, row.id as string));
      regated += 1;
      log.info({ repo }, 'onboarding:regated');
    }
  }

  return { reposChecked: repos.length, prsOpened, activated, regated };
}

/** Open the proposal PR. Returns its URL, or null if it could not be opened. */
async function proposePolicyFile(repo: string, log: Logger): Promise<string | null> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) return null;
  const gh = getOctokitClient();

  try {
    const { data: repoData } = await gh.repos.get({ owner, repo: name });
    const base = repoData.default_branch;

    // An existing open PR from our branch is reused rather than duplicated —
    // the sweep runs every tick and opening a PR is not idempotent.
    const { data: open } = await gh.pulls.list({ owner, repo: name, head: `${owner}:${BRANCH}`, state: 'open' });
    if (open.length > 0) return open[0]!.html_url;

    const { data: ref } = await gh.git.getRef({ owner, repo: name, ref: `heads/${base}` });
    await gh.git.createRef({ owner, repo: name, ref: `refs/heads/${BRANCH}`, sha: ref.object.sha });

    await gh.repos.createOrUpdateFileContents({
      owner,
      repo: name,
      path: POLICY_FILE_PATH,
      branch: BRANCH,
      message: 'Forge: propose agent policy for this repository',
      content: Buffer.from(policyFileTemplate({ repo, verifyCommand: null })).toString('base64'),
    });

    const { data: pr } = await gh.pulls.create({
      owner,
      repo: name,
      base,
      head: BRANCH,
      title: 'Forge: configure autonomous agent policy',
      body: [
        'Forge is connected to this repository but **will not run** until this pull request is merged.',
        '',
        'This file is the complete policy for this repo: which gates every change must pass, whether anything may merge without a human, and the budgets a run may spend. Auto-merge is proposed **off** — every change waits for a person until you decide otherwise.',
        '',
        'Merging authorises Forge to dispatch agents here. Closing it without merging leaves Forge dormant.',
      ].join('\n'),
    });
    return pr.html_url;
  } catch (err) {
    log.warn({ repo, err: err instanceof Error ? err.message : String(err) }, 'onboarding:propose_failed');
    return null;
  }
}
