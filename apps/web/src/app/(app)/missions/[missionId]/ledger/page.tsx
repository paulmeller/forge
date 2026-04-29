import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { MissionStatusBadge } from '@/components/mission-status-badge';
import { Timeline } from '@/components/timeline';
import { getMission } from '@/lib/missions';
import { listLedgerForMission } from '@/lib/ledger';
import { listTasksForMission } from '@/lib/tasks';

export const dynamic = 'force-dynamic';

export default async function MissionLedgerPage({
  params,
}: {
  params: Promise<{ missionId: string }>;
}) {
  const { missionId } = await params;

  const mission = await getMission(missionId);
  if (!mission) notFound();

  const [allEvents, tasks] = await Promise.all([
    listLedgerForMission(missionId, 2000),
    listTasksForMission(missionId),
  ]);

  return (
    <main className="container max-w-5xl py-8">
      <div className="mb-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
          <Link href={`/missions/${missionId}`}>&larr; {mission.name}</Link>
        </Button>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Ledger</h1>
          <MissionStatusBadge status={mission.status} />
          <span className="text-sm text-muted-foreground">
            {allEvents.length} events
          </span>
        </div>
      </div>

      <Timeline events={allEvents} tasks={tasks} />
    </main>
  );
}
