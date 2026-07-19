import type { TriageIssue } from './triage-planner';
import type { IssueGroup } from './triage-view';

export type WorkspaceIssueRow = {
  issue: TriageIssue;
  /** Null when Forge hasn't been asked to work on this issue yet. */
  group: IssueGroup | null;
};

/**
 * Pair each fetched GitHub issue with its triage progress (if any), keeping
 * the issues' own order (newest-first, as GitHub returned them). Groups with
 * no matching issue (e.g. a closed issue Forge worked on previously) are
 * dropped — the workspace only lists currently-open issues.
 */
export function mergeIssuesWithGroups(
  issues: TriageIssue[],
  groups: IssueGroup[],
): WorkspaceIssueRow[] {
  const byRef = new Map(groups.map((g) => [g.issueRef, g]));
  return issues.map((issue) => ({
    issue,
    group: byRef.get(`${issue.repo}#${issue.number}`) ?? null,
  }));
}
