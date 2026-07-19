'use client';

import { Check } from 'lucide-react';

import { statusLabel } from '@/lib/status-labels';
import { cn } from '@/lib/utils';
import type { Task, TaskStatus } from '@forge/db';

const DONE_STATUSES = new Set<TaskStatus>(['merged', 'resolved']);
const LIVE_STATUSES = new Set<TaskStatus>([
  'queued',
  'dispatching',
  'running',
  'turn_ended',
  'opening_pr',
  'awaiting_ci',
  'awaiting_verify',
  'awaiting_ai_review',
  'merging',
]);
const FAILED_STATUSES = new Set<TaskStatus>(['failed', 'abandoned']);

function StageNode({
  label,
  task,
  isActive,
  onClick,
}: {
  label: string;
  task: Task | null;
  isActive: boolean;
  onClick: () => void;
}) {
  const status = task?.status;
  const isDone = !!status && DONE_STATUSES.has(status);
  const isLive = !!status && LIVE_STATUSES.has(status);
  const isFailed = !!status && FAILED_STATUSES.has(status);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col items-center gap-1 rounded-md px-3 py-1.5 text-xs transition-colors',
        isActive ? 'bg-accent ring-1 ring-ring' : 'hover:bg-accent/50',
      )}
    >
      <span
        className={cn(
          'flex size-4 items-center justify-center rounded-full',
          isDone && 'bg-live text-background',
          isLive && 'animate-pulse bg-live',
          isFailed && 'bg-destructive',
          !isDone && !isLive && !isFailed && task && 'bg-warning',
          !task && 'border border-muted-foreground/30',
        )}
      >
        {isDone ? <Check className="size-3" /> : null}
      </span>
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">
        {task ? statusLabel(task.status) : 'Not started'}
      </span>
    </button>
  );
}

/**
 * Reproduce -> Fix is a pipeline, not two peer options — this reads as a
 * connected two-step stepper (status glyph per node, a line between them)
 * rather than side-by-side tabs, while staying clickable to switch which
 * stage's output renders below (same role the old Tabs played).
 */
export function StageStepper({
  reproduce,
  fix,
  activeStage,
  onStageChange,
}: {
  reproduce: Task | null;
  fix: Task | null;
  activeStage: 'reproduce' | 'fix';
  onStageChange: (stage: 'reproduce' | 'fix') => void;
}) {
  return (
    <div className="flex items-start">
      <StageNode
        label="Reproduce"
        task={reproduce}
        isActive={activeStage === 'reproduce'}
        onClick={() => onStageChange('reproduce')}
      />
      {/* Aligned to the circular glyphs' vertical center (py-1.5 + half of size-4), not the row's full height. */}
      <div className="mt-3.5 h-px w-8 shrink-0 bg-muted-foreground/30" aria-hidden />
      <StageNode
        label="Fix"
        task={fix}
        isActive={activeStage === 'fix'}
        onClick={() => onStageChange('fix')}
      />
    </div>
  );
}
