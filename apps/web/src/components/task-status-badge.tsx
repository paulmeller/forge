import { Badge } from '@/components/ui/badge';
import type { TaskStatus } from '@forge/db';

const VARIANT: Record<TaskStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  queued: 'outline',
  dispatching: 'secondary',
  running: 'default',
  turn_ended: 'secondary',
  opening_pr: 'secondary',
  awaiting_ci: 'secondary',
  awaiting_ai_review: 'secondary',
  awaiting_review: 'secondary',
  merging: 'default',
  merged: 'default',
  abandoned: 'outline',
  failed: 'destructive',
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <Badge variant={VARIANT[status] ?? 'outline'}>{status}</Badge>;
}
