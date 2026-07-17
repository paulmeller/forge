'use client';

import { useEffect, useRef } from 'react';
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
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  const selectTask = (taskId: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (taskId) next.set('task', taskId);
    else next.delete('task');
    const qs = next.toString();
    router.replace(`/missions/${missionId}${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  return (
    <div ref={containerRef} className="h-full min-h-0 overflow-y-auto rounded-lg border bg-muted/20 p-4">
      <Timeline
        events={events}
        tasks={tasks}
        selectedTaskId={selectedTaskId ?? null}
        onSelectTask={selectTask}
      />
    </div>
  );
}
