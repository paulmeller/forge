import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataChip } from '@/components/data-chip';
import { PrChip } from '@/components/pr-chip';
import { TaskProgressPill, type TaskRollup } from '@/components/progress-pill';
import { TaskStatusBadge } from '@/components/task-status-badge';
import type { HomeTaskRow } from '@/lib/home';
import { formatRelative, formatUsd } from '@/lib/format';
import { parseIssueRef } from '@/lib/mission-shape';
import { tokensToUsd } from '@/lib/rollups';

function hrefFor(row: HomeTaskRow): string {
  const parsed = row.task.issueRef ? parseIssueRef(row.task.issueRef) : null;
  return parsed
    ? `/repos/${parsed.repo}?issue=${parsed.number}`
    : `/missions/${row.task.missionId}/tasks/${row.task.id}`;
}

export function QueueSection({
  title,
  rows,
  rollups,
  empty,
  live = false,
}: {
  title: string;
  rows: HomeTaskRow[];
  rollups?: Map<string, TaskRollup>;
  empty: string;
  live?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="border-b px-3 py-2">
        <CardTitle className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-2">
        {rows.length === 0 ? (
          <p className="px-1 py-1 text-sm text-muted-foreground">{empty}</p>
        ) : (
          rows.map((row) => {
            const { task, missionName, isIssueMission } = row;
            const rollup = rollups?.get(task.id);
            return (
              <Link
                key={task.id}
                href={hrefFor(row)}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm hover:bg-accent"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {live ? (
                      <span
                        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-live"
                        aria-hidden
                      />
                    ) : null}
                    <p className="truncate font-medium">{task.issueRef ?? missionName}</p>
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground">{task.repo}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                  {rollup ? <TaskProgressPill rollup={rollup} /> : null}
                  {task.prUrl ? <PrChip prUrl={task.prUrl} prNumber={task.prNumber} linked={false} /> : null}
                  {(() => {
                    const usd = tokensToUsd(task.costTokens);
                    const chipCount =
                      (rollup ? 1 : 0) + (task.prUrl ? 1 : 0) + (usd > 0 ? 1 : 0) + 1; // +1 status badge
                    return (
                      <>
                        {usd > 0 ? <DataChip>{formatUsd(usd)}</DataChip> : null}
                        {isIssueMission && chipCount < 4 ? (
                          <Badge variant="outline" className="text-[10px]">
                            Issue
                          </Badge>
                        ) : null}
                      </>
                    );
                  })()}
                  <TaskStatusBadge status={task.status} haltReason={task.haltReason} />
                  <span
                    className="w-14 text-right text-[11px] tabular-nums text-muted-foreground"
                    suppressHydrationWarning
                  >
                    {formatRelative(task.updatedAt)}
                  </span>
                </div>
              </Link>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
