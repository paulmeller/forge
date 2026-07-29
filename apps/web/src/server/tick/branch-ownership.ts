/**
 * Provenance for the reconciler's PR-opening step.
 *
 * The agent chooses its own branch name — Claude Code pushes `claude/<slug>` —
 * so Forge cannot recognise its work by a name it dictated, and must discover
 * branches by listing the repo. The hazard is adopting a branch the task did
 * not produce: a task for issue #47 whose agent pushed nothing opened a PR
 * from a six-week-old branch that merely happened to be ahead of `main`, and
 * attributed it to the task. `branchIsTaskOwned` is the gate that stops that.
 *
 * Residual limitation (tracked, not solved here): a *different* task's branch
 * pushed inside this task's run window passes the time gate. The durable fix
 * is to hand the agent an exact branch name and match on it; until then the
 * name-owned candidates are tried first, so this fallback only fires when the
 * task pushed nothing under its own name.
 */

type CommitLike = {
  commit?: {
    committer?: { date?: string } | null;
    author?: { date?: string } | null;
  } | null;
};

/** The head commit's date in a base..head comparison (compare lists oldest→newest). */
export function newestCommitDate(commits: CommitLike[] | undefined): Date | null {
  if (!commits || commits.length === 0) return null;
  const head = commits[commits.length - 1];
  const raw = head?.commit?.committer?.date ?? head?.commit?.author?.date;
  return raw ? new Date(raw) : null;
}

/**
 * Whether the reconciler may open a PR from `branch` on this task's behalf.
 *
 * - A branch whose name is one Forge derived for the task is owned by
 *   construction — the name is the provenance, no time check needed.
 * - Any other (discovered) branch must have a head commit newer than the
 *   task's dispatch. Missing either date fails closed: no provenance signal
 *   is not a reason to adopt a stranger.
 */
export function branchIsTaskOwned(
  branch: string,
  taskCandidateNames: string[],
  headCommitDate: Date | null,
  dispatchedAt: Date | null,
): boolean {
  if (taskCandidateNames.includes(branch)) return true;
  if (!dispatchedAt || !headCommitDate) return false;
  return headCommitDate >= dispatchedAt;
}
