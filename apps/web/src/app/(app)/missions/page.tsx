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
import { getDashboardStats } from '@/lib/home';
import { isCampaignMission, isIssueMission, missionShapeLabel } from '@/lib/mission-shape';
import { listMissions } from '@/lib/missions';
import { rollupMissions, sparklinesForMissions } from '@/lib/rollups';
import { getOptionalUser } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).format(date);
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; backend?: string; q?: string; kind?: string; repo?: string }>;
}) {
  const {
    status: statusFilter,
    backend: backendFilter,
    q: searchQuery,
    kind: kindFilter,
    repo: repoFilter,
  } = await searchParams;
  const user = await getOptionalUser();
  const userId = user?.id ?? 'user_default';

  const stats = await getDashboardStats(userId);

  let allMissions = await listMissions();

  if (kindFilter === 'campaigns') {
    allMissions = allMissions.filter(isCampaignMission);
  } else if (kindFilter === 'issues') {
    allMissions = allMissions.filter(isIssueMission);
  }

  if (repoFilter) {
    allMissions = allMissions.filter((m) => m.workspaceRepo === repoFilter);
  }

  // Apply filters
  if (statusFilter) {
    const statuses = new Set(statusFilter.split(',').filter(Boolean));
    allMissions = allMissions.filter((m) => statuses.has(m.status));
  }
  if (backendFilter) {
    allMissions = allMissions.filter((m) => m.backend === backendFilter);
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    allMissions = allMissions.filter((m) => {
      const repos = (m.targetRepos ?? []) as string[];
      return (
        m.name.toLowerCase().includes(q) ||
        repos.some((r) => r.toLowerCase().includes(q))
      );
    });
  }

  const ids = allMissions.map((m) => m.id);
  const [rollups, sparklines] = await Promise.all([
    rollupMissions(ids),
    sparklinesForMissions(ids),
  ]);

  const hasFilters = !!(
    statusFilter ||
    backendFilter ||
    searchQuery ||
    (kindFilter && kindFilter !== 'all') ||
    repoFilter
  );

  return (
    <main className="container max-w-[1400px] py-10">
      {/* Setup banner */}
      {stats.connectedRepos === 0 && (
        <div className="mb-8 rounded-lg border border-dashed border-yellow-600/40 bg-yellow-950/20 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Connect your repos to get started</p>
              <p className="text-xs text-muted-foreground">
                Install the GitHub App and select repos. Then comment{' '}
                <code className="rounded bg-muted px-1 py-0.5">@forge</code> on any issue.
              </p>
            </div>
            <Button asChild size="sm">
              <Link href="/setup">Connect Repos</Link>
            </Button>
          </div>
        </div>
      )}

      {/* Missions header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Missions</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Every campaign and issue Forge is working on, across every repo.
          </p>
        </div>
        <Button asChild>
          <Link href="/missions/new">New Mission</Link>
        </Button>
      </div>

      <div className="mb-4">
        <MissionFilters />
      </div>

      {allMissions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {hasFilters
              ? 'No missions match the current filters.'
              : 'No missions yet. Comment @forge on a GitHub issue or create one manually.'}
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
              {allMissions.map((mission) => {
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
                      {isIssueMission(mission) ? (
                        <Link
                          href={`/repos/${mission.workspaceRepo}`}
                          className="mt-0.5 block truncate text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                        >
                          {missionShapeLabel(mission)}
                        </Link>
                      ) : (
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
