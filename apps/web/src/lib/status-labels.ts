/**
 * Machine status → human label (spec §1, docs/superpowers/specs/2026-07-18-ui-polish-design.md).
 * snake_case strings stay user-visible ONLY in console surfaces (ledger, timeline
 * raw payloads, session logs). Everywhere else, render statusLabel(s).
 */
export const STATUS_LABELS: Record<string, string> = {
  // Task statuses
  queued: 'Queued',
  dispatching: 'Dispatching',
  running: 'Running',
  turn_ended: 'Turn ended',
  opening_pr: 'Opening PR',
  awaiting_ci: 'Waiting on CI',
  awaiting_verify: 'Verifying',
  awaiting_ai_review: 'AI review',
  merging: 'Merging',
  awaiting_review: 'Needs review',
  failed: 'Failed',
  merged: 'Merged',
  resolved: 'Resolved',
  abandoned: 'Abandoned',
  // Triage headlines
  reproducing: 'Reproducing',
  fixing: 'Fixing',
  fix_review: 'Reviewing fix',
  fixed: 'Fixed',
  not_reproduced: 'Not reproduced',
  fix_skipped: 'Fix skipped',
  // Mission statuses
  draft: 'Draft',
  planning: 'Planning',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? s;
}
