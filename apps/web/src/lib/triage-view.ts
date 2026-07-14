import type { Task } from '@forge/db';

/**
 * A single issue's triage state, assembled from its reproduce and fix Tasks
 * (grouped by `issueRef`). Powers the issue-centric Console view.
 */
export type IssueGroup = {
  issueRef: string;
  repo: string;
  issueNumber: number | null;
  title: string;
  url: string | null;
  reproduce: Task | null;
  fix: Task | null;
  /** Coarse headline state for the row badge / sort order. */
  headline: TriageHeadline;
};

export type TriageHeadline =
  | 'reproducing' // reproduce Task still running
  | 'not_reproduced' // reproduce resolved, bug did not reproduce
  | 'fix_skipped' // fix abandoned because the bug did not reproduce
  | 'fixing' // reproduce positive, fix in flight
  | 'fixed' // fix merged
  | 'fix_review' // fix awaiting human review
  | 'failed'; // reproduce failed/abandoned with no verdict

const HEADLINE_ORDER: TriageHeadline[] = [
  'fixing',
  'reproducing',
  'fix_review',
  'fixed',
  'not_reproduced',
  'fix_skipped',
  'failed',
];

function promptVar(task: Task | null, key: string): unknown {
  const vars = task?.promptVars as Record<string, unknown> | null | undefined;
  return vars?.[key];
}

/**
 * Group a Mission's Tasks into per-issue triage rows. Non-triage Tasks (those
 * without an issueRef) are ignored. Pure — exported for testing.
 */
export function groupTasksByIssue(tasks: Task[]): IssueGroup[] {
  const byRef = new Map<string, { reproduce: Task | null; fix: Task | null }>();

  for (const task of tasks) {
    if (!task.issueRef) continue;
    if (task.kind !== 'reproduce' && task.kind !== 'fix') continue;
    const entry = byRef.get(task.issueRef) ?? { reproduce: null, fix: null };
    if (task.kind === 'reproduce') entry.reproduce = task;
    else entry.fix = task;
    byRef.set(task.issueRef, entry);
  }

  const groups: IssueGroup[] = [];
  for (const [issueRef, { reproduce, fix }] of byRef) {
    const numRaw = promptVar(reproduce ?? fix, 'issue_number');
    const issueNumber =
      typeof numRaw === 'number' ? numRaw : parseIssueNumber(issueRef);
    const titleRaw = promptVar(reproduce ?? fix, 'issue_title');
    const urlRaw = promptVar(reproduce ?? fix, 'issue_url');
    groups.push({
      issueRef,
      repo: (reproduce ?? fix)?.repo ?? issueRef.split('#')[0] ?? '',
      issueNumber,
      title: typeof titleRaw === 'string' && titleRaw ? titleRaw : issueRef,
      url: typeof urlRaw === 'string' ? urlRaw : null,
      reproduce,
      fix,
      headline: headlineFor(reproduce, fix),
    });
  }

  groups.sort(
    (a, b) => HEADLINE_ORDER.indexOf(a.headline) - HEADLINE_ORDER.indexOf(b.headline),
  );
  return groups;
}

/** Derive the coarse headline from the reproduce/fix Task states. Pure. */
export function headlineFor(reproduce: Task | null, fix: Task | null): TriageHeadline {
  const reproduced = reproduce?.verdict?.reproduced;

  // Fix outcomes take precedence once the fix stage has settled or is moving.
  if (fix) {
    if (fix.status === 'merged') return 'fixed';
    if (fix.status === 'awaiting_review') return 'fix_review';
    if (fix.status === 'abandoned') return 'fix_skipped';
    if (fix.status === 'failed') return 'failed';
    // A fix that's been claimed, or is queued behind a positive verdict, is "fixing".
    if (fix.status !== 'queued' || reproduced === true) return 'fixing';
  }

  if (reproduce) {
    if (reproduce.status === 'resolved') {
      return reproduced === true ? 'fixing' : 'not_reproduced';
    }
    if (reproduce.status === 'failed' || reproduce.status === 'abandoned') return 'failed';
  }

  return 'reproducing';
}

function parseIssueNumber(issueRef: string): number | null {
  const n = Number(issueRef.split('#')[1]);
  return Number.isFinite(n) ? n : null;
}
