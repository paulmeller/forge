import { Badge } from '@/components/ui/badge';
import { statusLabel } from '@/lib/status-labels';
import type { HaltReason, TaskStatus } from '@forge/db';

const VARIANT: Record<TaskStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  queued: 'outline',
  dispatching: 'secondary',
  running: 'default',
  turn_ended: 'secondary',
  awaiting_ci: 'secondary',
  awaiting_verify: 'secondary',
  awaiting_ai_review: 'secondary',
  ready_to_merge: 'secondary',
  needs_human: 'secondary',
  merging: 'default',
  merged: 'default',
  resolved: 'default',
  abandoned: 'outline',
  failed: 'destructive',
};

const HALT_LABEL: Record<HaltReason, string> = {
  max_turns: 'turn cap',
  task_token_cap: 'token cap',
  no_progress: 'no progress',
  budget_hard_stop: 'budget hard stop',
  manual_abort: 'aborted',
};

export function TaskStatusBadge({
  status,
  haltReason,
}: {
  status: TaskStatus;
  haltReason?: HaltReason | null;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant={VARIANT[status] ?? 'outline'}>{statusLabel(status)}</Badge>
      {haltReason ? (
        <span className="text-xs text-muted-foreground" title={`halted: ${HALT_LABEL[haltReason]}`}>
          {HALT_LABEL[haltReason]}
        </span>
      ) : null}
    </span>
  );
}
