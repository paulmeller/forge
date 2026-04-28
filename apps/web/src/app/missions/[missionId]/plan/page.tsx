import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MissionStatusBadge } from '@/components/mission-status-badge';
import { TemplateText } from '@/components/template-text';
import { getMission } from '@/lib/missions';
import { listTasksForMission } from '@/lib/tasks';

import { MissionActionButton } from '../mission-actions';
import { PlanEditor } from './plan-editor';

export const dynamic = 'force-dynamic';

export default async function PlanPreviewPage({
  params,
}: {
  params: Promise<{ missionId: string }>;
}) {
  const { missionId } = await params;
  const mission = await getMission(missionId);
  if (!mission) notFound();

  // Plan preview only makes sense in 'planning' status. If the operator landed
  // here from a wrong place, redirect them somewhere useful.
  if (mission.status === 'draft') redirect(`/missions/${mission.id}`);
  if (mission.status !== 'planning') redirect(`/missions/${mission.id}`);

  const tasks = await listTasksForMission(missionId);

  return (
    <main className="container max-w-4xl py-8">
      <div className="mb-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
          <Link href={`/missions/${mission.id}`}>← {mission.name}</Link>
        </Button>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">Plan preview</h1>
              <MissionStatusBadge status={mission.status} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Review and edit the {tasks.length} {tasks.length === 1 ? 'Task' : 'Tasks'} the
              Planner emitted. Nothing will dispatch until you click <span className="font-semibold">Start Mission</span>.
            </p>
          </div>
          <MissionActionButton
            missionId={mission.id}
            op="start"
            label="Start Mission"
            pendingLabel="Starting…"
            disabled={tasks.length === 0}
            disabledReason={tasks.length === 0 ? 'Add at least one Task' : undefined}
          />
        </div>
      </div>

      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Goal (template)</CardTitle>
          <CardDescription>Substituted per Task — chips become each Task&apos;s repo + base branch.</CardDescription>
        </CardHeader>
        <CardContent>
          <TemplateText text={mission.goal} />
        </CardContent>
      </Card>

      <PlanEditor missionId={mission.id} initialTasks={tasks} goalTemplate={mission.goal} />
    </main>
  );
}
