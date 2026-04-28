import { Badge } from '@/components/ui/badge';
import type { MissionStatus } from '@forge/db';

const VARIANT: Record<MissionStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  draft: 'outline',
  planning: 'secondary',
  running: 'default',
  paused: 'secondary',
  completed: 'default',
  cancelled: 'destructive',
};

export function MissionStatusBadge({ status }: { status: MissionStatus }) {
  return <Badge variant={VARIANT[status] ?? 'outline'}>{status}</Badge>;
}
