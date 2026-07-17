import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { MissionFilters } from '@/components/mission-filters';
import { MissionsTable } from '@/components/missions-table';
import { PageHeader, PageShell } from '@/components/page-shell';
import { getDashboardStats } from '@/lib/home';
import { filterMissionList, hasActiveMissionListFilters } from '@/lib/mission-list-filters';
import { listMissions } from '@/lib/missions';
import { rollupMissions, sparklinesForMissions } from '@/lib/rollups';
import { getOptionalUser } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

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
    <PageShell>
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

      <PageHeader
        title="Missions"
        subtitle="Every campaign and issue Forge is working on, across every repo."
        actions={
          <Button asChild>
            <Link href="/missions/new">New Mission</Link>
          </Button>
        }
      />

      <div className="mb-4">
        <MissionFilters />
      </div>

      <MissionsTable
        missions={allMissions}
        rollups={rollups}
        sparklines={sparklines}
        hasFilters={hasFilters}
      />
    </PageShell>
  );
}
