'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { TaskProgressPill, type TaskRollup } from '@/components/progress-pill';
import { TaskStatusBadge } from '@/components/task-status-badge';
import { cn } from '@/lib/utils';
import type { Task } from '@forge/db';

export function TaskCard({
  task,
  rollup,
  missionId,
}: {
  task: Task;
  rollup: TaskRollup;
  missionId: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('task') === task.id;

  const handleClick = () => {
    const next = new URLSearchParams(params.toString());
    if (selected) next.delete('task');
    else next.set('task', task.id);
    router.replace(`/missions/${missionId}?${next.toString()}`, { scroll: false });
  };

  return (
    <article
      className={cn(
        'cursor-pointer rounded-lg border bg-card px-3 py-2.5 transition hover:border-foreground/30',
        selected && 'border-foreground ring-1 ring-foreground/20',
      )}
      onClick={handleClick}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs font-semibold">{task.repo}</span>
        <TaskStatusBadge status={task.status} />
      </div>
      <TaskProgressPill rollup={rollup} />
      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="font-mono">{task.baseBranch}</span>
        {task.prUrl ? (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-foreground underline decoration-dotted hover:no-underline"
          >
            PR #{task.prNumber ?? ''}
          </a>
        ) : null}
        <Link
          href={`/missions/${missionId}/tasks/${task.id}`}
          onClick={(e) => e.stopPropagation()}
          className="ml-auto underline decoration-dotted hover:text-foreground"
        >
          open
        </Link>
      </div>
    </article>
  );
}
