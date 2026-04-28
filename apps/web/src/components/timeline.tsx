'use client';

import { useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import type { LedgerEvent, Task } from '@forge/db';

import { RoleTaggedEvent } from './role-tagged-event';

type TaskMeta = Pick<Task, 'id' | 'repo' | 'status'>;

export function Timeline({
  events,
  tasks,
  selectedTaskId,
  onSelectTask,
}: {
  events: LedgerEvent[];
  tasks: TaskMeta[];
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string | null) => void;
}) {
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const filtered = selectedTaskId ? events.filter((e) => e.taskId === selectedTaskId) : events;
    const sorted = [...filtered].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const byTask = new Map<string | null, LedgerEvent[]>();
    for (const e of sorted) {
      const k = e.taskId ?? null;
      if (!byTask.has(k)) byTask.set(k, []);
      byTask.get(k)!.push(e);
    }
    return byTask;
  }, [events, selectedTaskId]);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const toggleTask = (id: string) => {
    setCollapsedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">No events yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {selectedTaskId && (
        <button
          type="button"
          onClick={() => onSelectTask?.(null)}
          className="text-xs text-muted-foreground underline decoration-dotted hover:text-foreground"
        >
          ← Show all Tasks
        </button>
      )}
      {[...groups.entries()].map(([taskId, group]) => {
        const meta = taskId ? taskById.get(taskId) : null;
        const isCollapsed = taskId ? collapsedTasks.has(taskId) : false;
        return (
          <section key={taskId ?? '_mission'} className="rounded-lg border bg-card">
            <header className="flex items-center justify-between border-b px-4 py-2.5">
              <button
                type="button"
                onClick={() => taskId && toggleTask(taskId)}
                className={cn(
                  'flex items-baseline gap-2 text-left',
                  taskId && 'hover:underline decoration-dotted',
                )}
              >
                <span className="text-xs font-semibold">
                  {taskId ? meta?.repo ?? taskId : 'Mission events'}
                </span>
                {meta?.status && (
                  <span className="font-mono text-[10px] text-muted-foreground">{meta.status}</span>
                )}
                <span className="text-[10px] text-muted-foreground">{group.length} events</span>
              </button>
              {taskId && (
                <button
                  type="button"
                  onClick={() => onSelectTask?.(taskId)}
                  className="text-[10px] text-muted-foreground underline decoration-dotted hover:text-foreground"
                >
                  focus
                </button>
              )}
            </header>
            {!isCollapsed && (
              <ol className="space-y-1 px-4 py-3">
                {group.map((e) => (
                  <RoleTaggedEvent key={e.id} event={e} />
                ))}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
}
