import Link from 'next/link';

import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MissionFilters } from '@/components/mission-filters';
import { MissionProgressPill } from '@/components/progress-pill';
import { MissionStatusBadge } from '@/components/mission-status-badge';
import { Sparkline } from '@/components/sparkline';
import { listMissions } from '@/lib/missions';
import { rollupMissions, sparklinesForMissions } from '@/lib/rollups';

export const dynamic = 'force-dynamic';

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).format(date);
}

export default async function MissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; backend?: string; q?: string }>;
}) {
  const { status: statusFilter, backend: backendFilter, q: searchQuery } = await searchParams;

  let missions = await listMissions();

  // Apply filters
  if (statusFilter) {
    const statuses = new Set(statusFilter.split(',').filter(Boolean));
    missions = missions.filter((m) => statuses.has(m.status));
  }
  if (backendFilter) {
    missions = missions.filter((m) => m.backend === backendFilter);
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    missions = missions.filter((m) => {
      const repos = (m.targetRepos ?? []) as string[];
      return (
        m.name.toLowerCase().includes(q) ||
        repos.some((r) => r.toLowerCase().includes(q))
      );
    });
  }

  const ids = missions.map((m) => m.id);
  const [rollups, sparklines] = await Promise.all([
    rollupMissions(ids),
    sparklinesForMissions(ids),
  ]);

  const hasFilters = !!(statusFilter || backendFilter || searchQuery);

  return (
    <main className="container max-w-[1400px] py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Missions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Fleet-level changes orchestrated across repos.
          </p>
        </div>
        <Button asChild>
          <Link href="/missions/new">New Mission</Link>
        </Button>
      </div>

      <div className="mb-4">
        <MissionFilters />
      </div>

      {missions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {hasFilters ? 'No missions match the current filters.' : 'No missions yet. Create one to get started.'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
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
                  <TableRow key={mission.id}>
                    <TableCell className="max-w-[300px]">
                      <Link
                        href={`/missions/${mission.id}`}
                        className="block truncate font-medium hover:underline"
                      >
                        {mission.name}
                      </Link>
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
                      <Sparkline values={sparklines.get(mission.id) ?? []} className="text-foreground/70" />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{mission.backend}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatDate(mission.createdAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </main>
  );
}
