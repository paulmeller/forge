import Link from 'next/link';

import { Chip } from '@/components/progress-pill';
import { Sparkline } from '@/components/sparkline';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { formatDateTime } from '@/lib/format';
import { statusLabel } from '@/lib/status-labels';

import type { MissionStatus } from '@forge/db';

// 'live' is reserved for statuses actively in progress (planning/running) —
// 'good' would share the same underlying color as 'live' at lower opacity,
// making a completed repo read as too similar to an actively-running one.
// Everything else that doesn't need attention right now (including
// completed) uses the neutral 'muted' tone.
const STATUS_TONE: Record<MissionStatus, 'muted' | 'live' | 'good' | 'bad'> = {
  draft: 'muted',
  planning: 'live',
  running: 'live',
  paused: 'muted',
  completed: 'muted',
  cancelled: 'muted',
};

export type RepoRow = {
  repo: string;
  summary: {
    status: 'running' | 'completed';
    breakdown: Array<{ status: MissionStatus; count: number }>;
    mostRecentCreatedAt: Date;
  };
  sparkline: number[];
};

export function ReposTable({ rows, hasFilters }: { rows: RepoRow[]; hasFilters?: boolean }) {
  if (rows.length === 0) {
    return (
      <Empty className="border bg-card">
        <EmptyHeader>
          <EmptyTitle>
            {hasFilters ? 'No repos match the current filters.' : 'No mission activity to show.'}
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  const table = (
    <Table className="min-w-[900px]">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Progress</TableHead>
          <TableHead>Activity (24h)</TableHead>
          <TableHead className="text-right">Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ repo, summary, sparkline }) => {
          const [owner, name] = repo.split('/');
          return (
            <TableRow key={repo} className="relative cursor-pointer">
              <TableCell className="max-w-[300px]">
                <Link
                  href={`/repos/${owner}/${name}`}
                  className="absolute inset-0"
                  aria-label={repo}
                />
                <span className="block truncate font-mono font-medium">{repo}</span>
              </TableCell>
              <TableCell>
                <Badge variant={summary.status === 'running' ? 'default' : 'secondary'}>
                  {summary.status === 'running' ? 'Running' : 'Completed'}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  {summary.breakdown.map(({ status, count }) => (
                    <Chip key={status} tone={STATUS_TONE[status]}>
                      {count} {statusLabel(status)}
                    </Chip>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <Sparkline values={sparkline} className="text-foreground/70" />
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                {formatDateTime(summary.mostRecentCreatedAt)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );

  return <Card>{table}</Card>;
}
