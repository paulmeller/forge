'use client';

import { useRouter, useSearchParams } from 'next/navigation';

import { Timeline } from '@/components/timeline';
import type { LedgerEvent, Task } from '@forge/db';

export function TimelineClient({
  events,
  tasks,
  selectedTaskId,
  missionId,
}: {
  events: LedgerEvent[];
  tasks: Task[];
  selectedTaskId: string | undefined;
  missionId: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const selectTask = (taskId: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (taskId) next.set('task', taskId);
    else next.delete('task');
    const qs = next.toString();
    router.replace(`/missions/${missionId}${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  return (
    <Timeline
      events={events}
      tasks={tasks}
      selectedTaskId={selectedTaskId ?? null}
      onSelectTask={selectTask}
    />
  );
}
