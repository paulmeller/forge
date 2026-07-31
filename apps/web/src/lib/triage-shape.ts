/**
 * Does this issue warrant a `reproduce` phase before a `fix`?
 *
 * Triage used to emit a reproduce→fix pair for every issue unconditionally.
 * That shape is right for a bug and incoherent for anything else: a reproduce
 * Task settles on a verdict answering "did it reproduce?", and for a feature
 * request there is no honest answer, so the Task cannot succeed by
 * construction. Observed live on #67 ("build a validator"): the reproduce agent
 * did the sensible thing and built the feature, then was abandoned for emitting
 * no verdict, orphaning 488 lines of correct work on the remote (#70).
 *
 * Signals, strongest first: an explicit label (maintainers label deliberately),
 * then a conventional-commit title prefix (weaker — titles are written in a
 * hurry).
 *
 * The default is to KEEP the reproduce phase. Most real bug reports carry no
 * label and no conventional-commit prefix — a descriptive title and prose — so
 * defaulting the other way would silently disable reproduction for the majority
 * of genuine bugs, a far larger behaviour change than the defect this fixes.
 * The cost of a wrong reproduce is also now bounded: since #70, a reproduce Task
 * that pushed work is reclaimed into a PR rather than abandoned, so the failure
 * mode is a wasted session, not lost work. Only a clear non-bug signal skips it.
 */
export type TriageIssueShape = {
  title: string;
  labels?: string[];
  body?: string;
};

const BUG_LABELS = ['bug', 'defect', 'regression', 'crash'];
const NON_BUG_LABELS = ['enhancement', 'feature', 'documentation', 'docs', 'chore', 'refactor'];

/** Leading `fix:` / `bug:` conventional-commit prefix, optionally scoped: `fix(api):`. */
const BUG_PREFIX_RE = /^\s*(fix|bug|bugfix|hotfix)\s*(\([^)]*\))?\s*[:!]/i;

/** Leading `feat:` / `chore:` / `docs:` prefix — the issue is plainly not a bug. */
const NON_BUG_PREFIX_RE = /^\s*(feat|feature|chore|docs|doc|refactor|test|style|ci|build|perf)\s*(\([^)]*\))?\s*[:!]/i;

export function needsReproduce(issue: TriageIssueShape): boolean {
  const labels = (issue.labels ?? []).map((l) => l.trim().toLowerCase());

  // Labels win over the title: a maintainer who labels `bug` has made a
  // judgement, where a `feat:` prefix may just be habit.
  if (labels.some((l) => BUG_LABELS.includes(l))) return true;
  if (labels.some((l) => NON_BUG_LABELS.includes(l))) return false;

  // A bug prefix confirms; a non-bug prefix is the only thing that skips.
  // Anchored to the start so prose like "add a bug-report template" cannot
  // decide the shape either way.
  if (BUG_PREFIX_RE.test(issue.title)) return true;
  return !NON_BUG_PREFIX_RE.test(issue.title);
}
