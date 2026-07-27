import Link from 'next/link';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { MissionFilters } from '@/components/mission-filters';
import { MissionsTable } from '@/components/missions-table';
import { PageHeader, PageShell } from '@/components/page-shell';
import { getDashboardStats } from '@/lib/home';
import { filterMissionList, hasActiveMissionListFilters } from '@/lib/mission-list-filters';
import { listMissions } from '@/lib/missions';
import { rollupMissions, sparklinesForMissions } from '@/lib/rollups';
import { withAuth } from '@/lib/with-auth';

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
  // listMissions() below calls withAuth() itself, so a logged-out visitor was
  // already redirected — but only after getDashboardStats had run a full set
  // of queries as 'user_default'. Authenticating up front drops that wasted
  // work and removes a fallback identity that read like a data leak.
  const user = await withAuth();

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
    <PageShell>
      {/* Setup banner */}
      {stats.connectedRepos === 0 && (
        <Alert className="mb-8 flex items-center justify-between gap-4 border-dashed border-warning/40 text-foreground">
          <div>
            <AlertTitle className="text-sm">Connect your repos to get started</AlertTitle>
            <AlertDescription className="text-xs text-muted-foreground">
              Install the GitHub App and select repos. Then comment{' '}
              <code className="rounded bg-muted px-1 py-0.5">@forge</code> on any issue.
            </AlertDescription>
          </div>
          <Button asChild size="sm">
            <Link href="/setup">Connect Repos</Link>
          </Button>
        </Alert>
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

      <div className="rise rise-1 mb-4">
        <MissionFilters />
      </div>

      <div className="rise rise-2">
        <MissionsTable
          missions={allMissions}
          rollups={rollups}
          sparklines={sparklines}
          hasFilters={hasFilters}
        />
      </div>
    </PageShell>
  );
}
