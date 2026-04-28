import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { MissionStatusBadge } from '@/components/mission-status-badge';
import { RoleTaggedEvent } from '@/components/role-tagged-event';
import { getMission } from '@/lib/missions';
import { listLedgerForMission } from '@/lib/ledger';
import { listTasksForMission } from '@/lib/tasks';

export const dynamic = 'force-dynamic';

export default async function MissionLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ missionId: string }>;
  searchParams: Promise<{ task?: string; type?: string }>;
}) {
  const { missionId } = await params;
  const { task: filterTask, type: filterType } = await searchParams;

  const mission = await getMission(missionId);
  if (!mission) notFound();

  const [allEvents, tasks] = await Promise.all([
    listLedgerForMission(missionId, 2000),
    listTasksForMission(missionId),
  ]);

  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Apply filters
  let events = allEvents;
  if (filterTask) {
    events = events.filter((e) => e.taskId === filterTask);
  }
  if (filterType) {
    events = events.filter((e) => e.eventType.includes(filterType));
  }

  // Collect unique event types for the filter
  const eventTypes = Array.from(new Set(allEvents.map((e) => e.eventType))).sort();

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
            {events.length}{events.length !== allEvents.length ? ` of ${allEvents.length}` : ''} events
          </span>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterPill
          label="All tasks"
          href={buildUrl(missionId, { type: filterType })}
          active={!filterTask}
        />
        {tasks.map((t) => (
          <FilterPill
            key={t.id}
            label={t.repo}
            href={buildUrl(missionId, { task: t.id, type: filterType })}
            active={filterTask === t.id}
          />
        ))}
        <span className="mx-2 h-4 w-px bg-border" />
        <FilterPill
          label="All types"
          href={buildUrl(missionId, { task: filterTask })}
          active={!filterType}
        />
        {eventTypes.map((et) => (
          <FilterPill
            key={et}
            label={et}
            href={buildUrl(missionId, { task: filterTask, type: et })}
            active={filterType === et}
          />
        ))}
      </div>

      {/* Event list */}
      {events.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">No events match the current filters.</p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card">
          <ol className="divide-y">
            {events.map((e) => (
              <li key={e.id} className="px-4 py-2.5">
                <div className="flex items-baseline gap-2 text-[11px] text-muted-foreground mb-1">
                  {e.taskId && (
                    <span className="font-mono font-medium text-foreground/70">
                      {taskById.get(e.taskId)?.repo ?? e.taskId.slice(0, 12)}
                    </span>
                  )}
                  <span className="tabular-nums">
                    {e.createdAt.toLocaleString()}
                  </span>
                  {e.sourceEventId && (
                    <span className="font-mono truncate max-w-[120px]" title={e.sourceEventId}>
                      {e.sourceEventId.slice(0, 12)}
                    </span>
                  )}
                </div>
                <RoleTaggedEvent event={e} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </main>
  );
}

function buildUrl(
  missionId: string,
  params: { task?: string; type?: string },
): string {
  const sp = new URLSearchParams();
  if (params.task) sp.set('task', params.task);
  if (params.type) sp.set('type', params.type);
  const qs = sp.toString();
  return `/missions/${missionId}/ledger${qs ? `?${qs}` : ''}`;
}

function FilterPill({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-mono transition ${
        active
          ? 'border-foreground bg-foreground text-background'
          : 'border-border bg-card text-muted-foreground hover:border-foreground/30'
      }`}
    >
      {label}
    </Link>
  );
}
