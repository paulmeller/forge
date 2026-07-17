import Link from 'next/link';
import type { Mission } from '@forge/db';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DataChip } from '@/components/data-chip';
import { MissionProgressPill, type MissionRollup } from '@/components/progress-pill';
import { MissionStatusBadge } from '@/components/mission-status-badge';
import { Sparkline } from '@/components/sparkline';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Card } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format';
import { missionShapeLabel } from '@/lib/mission-shape';

export function MissionsTable({
  missions,
  rollups,
  sparklines,
  hasFilters,
  bare = false,
}: {
  missions: Mission[];
  rollups: Map<string, MissionRollup>;
  sparklines: Map<string, number[]>;
  hasFilters: boolean;
  /** Skip the outer rounded-border wrapper — for embedding inside a parent panel that already provides one. */
  bare?: boolean;
}) {
  if (missions.length === 0) {
    return (
      <Empty className={bare ? undefined : 'border bg-card'}>
        <EmptyHeader>
          <EmptyTitle>
            {hasFilters
              ? 'No missions match the current filters.'
              : 'No missions yet. Comment @forge on a GitHub issue or create one manually.'}
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  const table = (
    <Table className="min-w-[1000px]">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Progress</TableHead>
          <TableHead>Activity (24h)</TableHead>
          <TableHead>Backend</TableHead>
          <TableHead className="text-right">Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {missions.map((mission) => {
          const rollup = rollups.get(mission.id);
          return (
            <TableRow key={mission.id} className="relative cursor-pointer">
              <TableCell className="max-w-[300px]">
                <Link
                  href={`/missions/${mission.id}`}
                  className="absolute inset-0"
                  aria-label={mission.name}
                />
                <span className="block truncate font-medium">{mission.name}</span>
                {mission.issueRef ? null : (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {missionShapeLabel(mission)}
                  </p>
                )}
              </TableCell>
              <TableCell>
                <MissionStatusBadge status={mission.status} />
              </TableCell>
              <TableCell>
                {rollup && rollup.total > 0 ? (
                  <MissionProgressPill rollup={rollup} />
                ) : (
                  <span className="text-xs text-muted-foreground">no tasks</span>
                )}
              </TableCell>
              <TableCell>
                <Sparkline
                  values={sparklines.get(mission.id) ?? []}
                  className="text-foreground/70"
                />
              </TableCell>
              <TableCell>
                <DataChip title={mission.backend}>
                  {mission.backend === 'managed-agents' ? 'ma' : 'gw'}
                </DataChip>
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                {formatDateTime(mission.createdAt)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
  return bare ? <div>{table}</div> : <Card>{table}</Card>;
}
