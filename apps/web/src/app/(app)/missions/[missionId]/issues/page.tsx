import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { IssueTriageCard } from '@/components/issue-triage-card';
import { LiveRefresh } from '@/components/live-refresh';
import { MissionStatusBadge } from '@/components/mission-status-badge';
import { PageHeader, PageShell } from '@/components/page-shell';
import { getMission } from '@/lib/missions';
import { listTasksForMission } from '@/lib/tasks';
import { groupTasksByIssue } from '@/lib/triage-view';

export const dynamic = 'force-dynamic';

export default async function MissionIssuesPage({
  params,
}: {
  params: Promise<{ missionId: string }>;
}) {
  const { missionId } = await params;

  const mission = await getMission(missionId);
  if (!mission) notFound();

  const tasks = await listTasksForMission(missionId);
  const groups = groupTasksByIssue(tasks);

  const counts = groups.reduce<Record<string, number>>((acc, g) => {
    acc[g.headline] = (acc[g.headline] ?? 0) + 1;
    return acc;
  }, {});
  const fixed = counts.fixed ?? 0;
  const active = (counts.fixing ?? 0) + (counts.reproducing ?? 0);

  return (
    <PageShell className="max-w-[1000px]">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
        <Link href={`/missions/${missionId}`}>← Mission control</Link>
      </Button>
      <PageHeader
        title={
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate">{mission.name} — issues</span>
            <span className="normal-case">
              <MissionStatusBadge status={mission.status} />
            </span>
          </span>
        }
        subtitle={`${groups.length} issue${groups.length === 1 ? '' : 's'} · ${active} active · ${fixed} fixed`}
        actions={
          mission.status === 'running' || mission.status === 'planning' ? (
            <LiveRefresh intervalMs={5000} />
          ) : undefined
        }
      />
      {(mission.issueQuery || mission.targetRepos?.length === 1) && (
        <div className="-mt-4 mb-6 space-y-2">
          {mission.issueQuery && (
            <p className="inline-block rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
              {mission.issueQuery}
            </p>
          )}
          {mission.targetRepos?.length === 1 ? (
            <p>
              <Link
                href={`/repos/${mission.targetRepos[0]}`}
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                View in repo workspace →
              </Link>
            </p>
          ) : null}
        </div>
      )}

      {groups.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>
              {mission.plannerStrategy === 'triage'
                ? 'No issues yet. Plan and start the Mission to enumerate issues from the query.'
                : 'This Mission is not a triage Mission — it has no per-issue reproduce/fix pipeline.'}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <IssueTriageCard key={g.issueRef} group={g} missionId={missionId} />
          ))}
        </div>
      )}
    </PageShell>
  );
}
