import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { IssueTriageCard } from '@/components/issue-triage-card';
import { LiveRefresh } from '@/components/live-refresh';
import { MissionStatusBadge } from '@/components/mission-status-badge';
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
    <main className="container max-w-[1000px] py-8">
      <div className="mb-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
          <Link href={`/missions/${missionId}`}>← Mission control</Link>
        </Button>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                {mission.name} — issues
              </h1>
              <MissionStatusBadge status={mission.status} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {groups.length} issue{groups.length === 1 ? '' : 's'} · {active} active · {fixed} fixed
            </p>
          </div>
          {mission.status === 'running' || mission.status === 'planning' ? (
            <LiveRefresh intervalMs={5000} />
          ) : null}
        </div>
        {mission.issueQuery && (
          <p className="mt-3 inline-block rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
            {mission.issueQuery}
          </p>
        )}
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {mission.plannerStrategy === 'triage'
            ? 'No issues yet. Plan and start the Mission to enumerate issues from the query.'
            : 'This Mission is not a triage Mission — it has no per-issue reproduce/fix pipeline.'}
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <IssueTriageCard key={g.issueRef} group={g} missionId={missionId} />
          ))}
        </div>
      )}
    </main>
  );
}
