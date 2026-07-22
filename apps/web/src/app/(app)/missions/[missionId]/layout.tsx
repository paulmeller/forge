import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { ConsoleShell } from '@/components/console-shell';
import { LiveRefresh } from '@/components/live-refresh';
import { MissionStatusBadge } from '@/components/mission-status-badge';
import { MissionTabs } from '@/components/mission-tabs';
import { getMission } from '@/lib/missions';
import { listTasksForMission } from '@/lib/tasks';

import { MissionActionButton } from './mission-actions';

export const dynamic = 'force-dynamic';

export default async function MissionLayout({
  params,
  children,
}: {
  params: Promise<{ missionId: string }>;
  children: React.ReactNode;
}) {
  const { missionId } = await params;

  const mission = await getMission(missionId);
  if (!mission) notFound();

  // Duplicates page.tsx's own listTasksForMission call. No React cache()-based
  // request memoization exists anywhere in this codebase today (checked) —
  // introducing that pattern for one boolean isn't worth diverging from
  // existing conventions. This is a small, accepted duplicate query.
  const tasks = await listTasksForMission(missionId);
  const targetRepos = mission.targetRepos ?? [];

  return (
    <ConsoleShell>
      <div className="title-glow mb-6 shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h1 className="truncate font-title text-3xl uppercase tracking-tight">
                {mission.name}
              </h1>
              <MissionStatusBadge status={mission.status} />
            </div>
            <div className="mt-1 flex items-center gap-2">
              <p className="font-mono text-[11px] text-muted-foreground">{mission.id}</p>
              {mission.status === 'running' || mission.status === 'planning' ? (
                <LiveRefresh intervalMs={5000} />
              ) : null}
            </div>
          </div>
          <div className="flex items-start gap-2">
            {mission.plannerStrategy === 'triage' ? (
              <Button asChild variant="outline">
                <Link href={`/missions/${mission.id}/issues`}>View by issue →</Link>
              </Button>
            ) : null}
            {mission.status === 'draft'
              ? (() => {
                  const isTriage = mission.plannerStrategy === 'triage';
                  const missingSource = isTriage
                    ? !mission.issueQuery?.trim()
                    : targetRepos.length === 0;
                  return (
                    <MissionActionButton
                      missionId={mission.id}
                      op="plan"
                      label="Plan Mission"
                      disabled={missingSource}
                      disabledReason={
                        missingSource
                          ? isTriage
                            ? 'Add an issue search query first'
                            : 'Add target repos first'
                          : undefined
                      }
                    />
                  );
                })()
              : null}
            {mission.status === 'planning' ? (
              <>
                <Button asChild variant="outline">
                  <Link href={`/missions/${mission.id}/plan`}>Review plan →</Link>
                </Button>
                <MissionActionButton
                  missionId={mission.id}
                  op="start"
                  label="Start Mission"
                  disabled={tasks.length === 0}
                  disabledReason={tasks.length === 0 ? 'No Tasks to dispatch' : undefined}
                />
              </>
            ) : null}
            {mission.status === 'running' ? (
              <MissionActionButton
                missionId={mission.id}
                op="pause"
                label="Pause"
                variant="outline"
              />
            ) : null}
            {mission.status === 'paused' ? (
              <MissionActionButton missionId={mission.id} op="resume" label="Resume" />
            ) : null}
          </div>
        </div>
      </div>
      <MissionTabs missionId={mission.id} />
      <div className="mt-6 flex min-h-0 flex-1 flex-col">{children}</div>
    </ConsoleShell>
  );
}
