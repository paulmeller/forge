import Link from 'next/link';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { MissionFilters } from '@/components/mission-filters';
import { PageHeader, PageShell } from '@/components/page-shell';
import { ReposTable } from '@/components/repos-table';
import { getDashboardStats } from '@/lib/home';
import { groupMissionsByRepo, summarizeRepoMissions } from '@/lib/group-missions-by-repo';
import { filterMissionList, hasActiveMissionListFilters } from '@/lib/mission-list-filters';
import { listUserRepos } from '@/lib/mission-defaults-db';
import { listMissions } from '@/lib/missions';
import { countBlockedTasksByRepo } from '@/lib/repo-activity';
import { sparklinesForMissions } from '@/lib/rollups';
import { withAuth } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

export default async function ReposPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; backend?: string; q?: string; kind?: string }>;
}) {
  const user = await withAuth();
  const { status, backend, q, kind } = await searchParams;
  const filters = { status, backend, q, kind };
  const hasFilters = hasActiveMissionListFilters(filters);

  const allMissions = await listMissions();

  // Genuinely zero mission activity ever, with no filters active — the
  // "nothing to filter" case, distinct from "filters matched nothing" below.
  if (allMissions.length === 0 && !hasFilters) {
    const connectedRepos = await listUserRepos(user.id);
    return (
      <PageShell className="max-w-3xl">
        <PageHeader title="Repos" subtitle="Mission activity across your connected repos." />
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyTitle>No mission activity yet.</EmptyTitle>
            <EmptyDescription>
              {connectedRepos.length === 0 ? (
                <Link href="/setup">Connect repos in Setup</Link>
              ) : (
                <Link href="/missions/new">Start a new mission</Link>
              )}
              .
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageShell>
    );
  }

  const stats = await getDashboardStats(user.id);
  const missions = filterMissionList(allMissions, filters);
  const missionsByRepo = groupMissionsByRepo(missions);
  const repoNames = [...missionsByRepo.keys()].sort();

  const ids = missions.map((m) => m.id);
  const sparklines = await sparklinesForMissions(ids);
  const blockersByRepo = await countBlockedTasksByRepo(user.id);
  const connectedRepos = await listUserRepos(user.id);

  const rows = repoNames.map((repo) => {
    const repoMissions = missionsByRepo.get(repo)!;
    const summary = summarizeRepoMissions(repoMissions);
    const sparkline = repoMissions.reduce<number[]>((acc, m) => {
      const s = sparklines.get(m.id) ?? [];
      return acc.map((v, i) => v + (s[i] ?? 0));
    }, new Array(30).fill(0));
    const missionCount = summary.breakdown.reduce((sum, b) => sum + b.count, 0);
    const blockers = blockersByRepo.get(repo) ?? 0;
    return { repo, summary, sparkline, missionCount, blockers };
  });

  return (
    <PageShell>
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
        title="Repos"
        subtitle="Mission activity across your connected repos."
        actions={
          <Button asChild>
            <Link href="/missions/new">New Mission</Link>
          </Button>
        }
      />

      <div className="rise rise-1 mb-4 grid grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="font-mono text-xl font-semibold">{connectedRepos.length}</p>
          <p className="text-xs text-muted-foreground">Repos connected</p>
        </div>
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="font-mono text-xl font-semibold">{[...blockersByRepo.keys()].length}</p>
          <p className="text-xs text-muted-foreground">Repos with open blockers</p>
        </div>
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="font-mono text-xl font-semibold">${stats.spentUsd.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">Total spend</p>
        </div>
      </div>

      <div className="rise rise-2 mb-4">
        <MissionFilters basePath="/repos" />
      </div>

      <div className="rise rise-3">
        <ReposTable rows={rows} hasFilters={hasFilters} />
      </div>
    </PageShell>
  );
}
