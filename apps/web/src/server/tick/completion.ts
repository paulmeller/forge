import { forgeBranchName } from './branch-name';

/** Whether this task's Forge-named branch carries work on the remote. */
export type ForgeBranchState =
  | { present: false }
  | {
      present: true;
      aheadBy: number;
      filesChanged: number;
      /** Added lines across the changed files — real blast radius, not a file count (#75). */
      additions: number;
      /** Deleted lines across the changed files (#75). */
      deletions: number;
      /**
       * Head commit of the branch, when the compare response carried one.
       * Lets a caller tell "the agent pushed more work since we last looked"
       * from "the agent pushed once and has been spinning since" — the
       * distinction the no-progress guard needs (#57). Null when the backend
       * did not return commits; callers must treat null as "cannot tell".
       */
      headSha: string | null;
    };

type CompareCapable = {
  repos: {
    compareCommits(params: {
      owner: string;
      repo: string;
      base: string;
      head: string;
    }): Promise<{
      data: {
        ahead_by?: number;
        files?: Array<{ additions?: number; deletions?: number }>;
        commits?: Array<{ sha?: string }>;
      };
    }>;
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
    // compareCommits returns commits oldest-first, so the branch head is last.
    const commits = data.commits ?? [];
    const files = data.files ?? [];
    return {
      present: true,
      aheadBy,
      filesChanged: files.length,
      additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
      headSha: commits[commits.length - 1]?.sha ?? null,
    };
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
