import { Octokit } from '@octokit/rest';

import { env } from './env';

/**
 * Shared Octokit client authenticated as the Forge GitHub App, for the
 * modules that need to talk to GitHub as the app (currently `auto-merge`'s
 * sweep, the reconciler's merging sweep, and GitHub-dispatch's plan-link
 * comment). One singleton, one auth path — don't add another
 * `new Octokit(...)` call elsewhere; import this instead.
 *
 * Lives in `lib/` (not `server/tick/`) so both `server/tick/*` and `lib/*`
 * modules can depend on it without `lib/` reaching into `server/tick/`.
 */
let octokit: Octokit | undefined;
export function getOctokitClient(): Octokit {
  if (!octokit) {
    if (!env.GITHUB_APP_TOKEN) throw new Error('GITHUB_APP_TOKEN not configured');
    octokit = new Octokit({ auth: env.GITHUB_APP_TOKEN });
  }
  return octokit;
}
