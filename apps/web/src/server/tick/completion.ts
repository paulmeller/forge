import { forgeBranchName } from './branch-name';

/** Whether this task's Forge-named branch carries work on the remote. */
export type ForgeBranchState =
  | { present: false }
  | { present: true; aheadBy: number; filesChanged: number };

type CompareCapable = {
  repos: {
    compareCommits(params: {
      owner: string;
      repo: string;
      base: string;
      head: string;
    }): Promise<{ data: { ahead_by?: number; files?: unknown[] } }>;
  };
};

/**
 * Ask GitHub whether `forge/<taskId>` exists with commits ahead of base.
 *
 * This is Forge's definition of "the agent produced work". It deliberately
 * consults the remote rather than a task column, so it is correct from any
 * task state — including a task a guardrail halted before it could report in.
 * A missing branch 404s on compare, which is an answer, not an error.
 */
export async function checkForgeBranch(
  gh: CompareCapable,
  opts: { owner: string; repo: string; baseBranch: string; taskId: string },
): Promise<ForgeBranchState> {
  try {
    const { data } = await gh.repos.compareCommits({
      owner: opts.owner,
      repo: opts.repo,
      base: opts.baseBranch,
      head: forgeBranchName(opts.taskId),
    });
    const aheadBy = data.ahead_by ?? 0;
    if (aheadBy === 0) return { present: false };
    return { present: true, aheadBy, filesChanged: data.files?.length ?? 0 };
  } catch (err) {
    // A 404 is an answer: the branch does not exist, so there is no work.
    // Anything else (5xx, rate limit, network) means we could not tell —
    // and "could not tell" must not be reported as "no work". Callers act on
    // absence: a salvage push, or declining to reclaim real pushed work. Let
    // it propagate; the tick wraps every stage, so this logs and retries on
    // the next pass instead of acting on a bad answer.
    if ((err as { status?: number }).status === 404) return { present: false };
    throw err;
  }
}
