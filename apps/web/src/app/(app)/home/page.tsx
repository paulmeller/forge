import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from '@forge/db/orm';

import { githubInstallations } from '@forge/db';

import { Button } from '@/components/ui/button';
import { MissionFilters } from '@/components/mission-filters';
import { MissionsTable } from '@/components/missions-table';
import { db } from '@/lib/db';
import { getDashboardStats } from '@/lib/home';
import { filterMissionList, hasActiveMissionListFilters } from '@/lib/mission-list-filters';
import { listMissions } from '@/lib/missions';
import { rollupMissions, sparklinesForMissions } from '@/lib/rollups';
import { withAuth } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; backend?: string; q?: string; kind?: string; repo?: string }>;
}) {
  const user = await withAuth();

  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, user.id))
    .limit(1);
  if (!installation) redirect('/setup');

  const {
    status: statusFilter,
    backend: backendFilter,
    q: searchQuery,
    kind: kindFilter,
    repo: repoFilter,
  } = await searchParams;

  const stats = await getDashboardStats(user.id);

  const filters = {
    kind: kindFilter,
    repo: repoFilter,
    status: statusFilter,
    backend: backendFilter,
    q: searchQuery,
  };
  const allMissions = filterMissionList(await listMissions(), filters);

  const ids = allMissions.map((m) => m.id);
  const [rollups, sparklines] = await Promise.all([
    rollupMissions(ids),
    sparklinesForMissions(ids),
  ]);

  const hasFilters = hasActiveMissionListFilters(filters);

  return (
    <main className="container max-w-[1400px] py-10">
      <div className="mb-8">
        <h1 className="font-title text-3xl uppercase tracking-tight">Home</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything running across your repos and missions.
        </p>
      </div>

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

      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-lg border px-4 py-3">
          <p className="text-2xl font-semibold">{stats.mergedThisWeek}</p>
          <p className="text-xs text-muted-foreground">PRs merged this week</p>
        </div>
        <div className="rounded-lg border px-4 py-3">
          <p className="text-2xl font-semibold">{stats.activeAgents}</p>
          <p className="text-xs text-muted-foreground">Active agents</p>
        </div>
        <div className="rounded-lg border px-4 py-3">
          <p className="text-2xl font-semibold">${stats.spentUsd.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">Total spend</p>
        </div>
        <div className="rounded-lg border px-4 py-3">
          <p className="text-2xl font-semibold">{stats.connectedRepos}</p>
          <p className="text-xs text-muted-foreground">Connected repos</p>
        </div>
      </div>

      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Missions
          </p>
          <Button asChild size="sm">
            <Link href="/missions/new">New Mission</Link>
          </Button>
        </div>

        <div className="border-b p-3">
          <MissionFilters basePath="/home" />
        </div>

        <MissionsTable
          missions={allMissions}
          rollups={rollups}
          sparklines={sparklines}
          hasFilters={hasFilters}
          bare
        />
      </div>
    </main>
  );
}
