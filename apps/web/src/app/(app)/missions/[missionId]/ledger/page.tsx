import { notFound } from 'next/navigation';

import { MissionStatusBadge } from '@/components/mission-status-badge';
import { PageHeader, PageShell } from '@/components/page-shell';
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
    <PageShell className="max-w-5xl">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Ledger
            <span className="normal-case">
              <MissionStatusBadge status={mission.status} />
            </span>
          </span>
        }
        subtitle={`${allEvents.length} events`}
      />

      <Timeline events={allEvents} tasks={tasks} />
    </PageShell>
  );
}
