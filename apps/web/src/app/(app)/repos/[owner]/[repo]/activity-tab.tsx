import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { TaskStatusBadge } from '@/components/task-status-badge';
import type { RepoActivityRow } from '@/lib/repo-activity';

export function ActivityTab({ rows }: { rows: RepoActivityRow[] }) {
  if (rows.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No Tasks have touched this repo yet.</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <Link
          key={row.task.id}
          href={`/missions/${row.missionId}/tasks/${row.task.id}`}
          className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm hover:bg-accent"
        >
          <div className="min-w-0">
            <p className="truncate font-medium">{row.task.issueRef ?? row.missionName}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{row.task.kind}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {row.isIssueMission ? (
              <Badge variant="outline" className="text-[10px]">
                Issue
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">
                Campaign
              </Badge>
            )}
            <TaskStatusBadge status={row.task.status} haltReason={row.task.haltReason} />
          </div>
        </Link>
      ))}
    </div>
  );
}
