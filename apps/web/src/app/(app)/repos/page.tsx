import Link from 'next/link';

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { PageHeader, PageShell } from '@/components/page-shell';
import { ReposTable } from '@/components/repos-table';
import { groupMissionsByRepo, summarizeRepoMissions } from '@/lib/group-missions-by-repo';
import { listUserRepos } from '@/lib/mission-defaults-db';
import { listMissions } from '@/lib/missions';
import { sparklinesForMissions } from '@/lib/rollups';
import { withAuth } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

export default async function ReposPage() {
  const user = await withAuth();
  const missions = await listMissions();
  const missionsByRepo = groupMissionsByRepo(missions);
  const repoNames = [...missionsByRepo.keys()].sort();

  if (repoNames.length === 0) {
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

  const allIds = missions.map((m) => m.id);
  const sparklines = await sparklinesForMissions(allIds);

  const rows = repoNames.map((repo) => {
    const repoMissions = missionsByRepo.get(repo)!;
    const summary = summarizeRepoMissions(repoMissions);
    const sparkline = repoMissions.reduce<number[]>((acc, m) => {
      const s = sparklines.get(m.id) ?? [];
      return acc.map((v, i) => v + (s[i] ?? 0));
    }, new Array(30).fill(0));
    return { repo, summary, sparkline };
  });

  return (
    <PageShell>
      <PageHeader title="Repos" subtitle="Mission activity across your connected repos." />
      <ReposTable rows={rows} />
    </PageShell>
  );
}
