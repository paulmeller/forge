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
import { formatDateTime } from '@/lib/format';
import { statusLabel } from '@/lib/status-labels';

import type { MissionStatus } from '@forge/db';

const STATUS_TONE: Record<MissionStatus, 'muted' | 'live' | 'good' | 'bad'> = {
  draft: 'muted',
  planning: 'live',
  running: 'live',
  paused: 'muted',
  completed: 'good',
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

export function ReposTable({ rows }: { rows: RepoRow[] }) {
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
