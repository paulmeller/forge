'use client';

import { useEffect, useState, useTransition } from 'react';
import { Check } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PrChip } from '@/components/pr-chip';
import { TaskProgressPill, type TaskRollup } from '@/components/progress-pill';
import { MarkdownMessage } from '@/components/markdown-message';
import { SteerInput } from '@/components/steer-input';
import { Spinner } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format';
import { deriveMergeStepper, type MergeStepperState } from '@/lib/merge-stepper';
import { lastAssistantMessage } from '@/lib/session-log-format';
import { cn } from '@/lib/utils';
import type { IssueGroup } from '@/lib/triage-view';
import type { Task } from '@forge/db';

import { abortTask } from './actions';
import { StageStepper } from './stage-stepper';

export type LedgerRow = { id: string; eventType: string; payload: unknown; createdAt: Date };

/** The task currently selected via the attempt/stage tabs, lifted up so
 *  WorkspaceList can render the file browser and log console for it in
 *  their own persistent panels, outside this component. */
export type ActiveTaskInfo = {
  task: Task;
  ledger: LedgerRow[];
  isLive: boolean;
  mergeStepper: MergeStepperState;
};

const RUNNING_STATUSES = new Set(['queued', 'dispatching', 'running']);
const ABORTABLE_STATUSES = new Set(['dispatching', 'running', 'turn_ended', 'opening_pr']);

function formatStarted(task: Task | null): string | null {
  const at = task?.dispatchedAt ?? task?.createdAt ?? null;
  if (!at) return null;
  return formatDateTime(at, { seconds: true });
}

/** Renders the full CI -> Merge stepper (or the failed/hidden fallback) as
 *  one visually contained widget — a bordered pill with numbered, connected
 *  steps, rather than loose badges + a hairline the eye has to piece
 *  together as "a stepper." */
export function MergeStepper({ state }: { state: MergeStepperState }) {
  if (state.kind === 'failed') {
    return (
      <Badge variant="destructive" className="text-[10px] uppercase">
        Task failed
      </Badge>
    );
  }
  if (state.kind !== 'steps') return null;

  const steps: Array<{ label: string; state: (typeof state)['ci'] }> = [
    { label: 'CI', state: state.ci },
    { label: 'Merge', state: state.merge },
  ];

  return (
    <div className="flex w-full flex-col gap-2">
      {state.needsAttention ? (
        <Badge variant="destructive" className="w-fit text-[10px] uppercase">
          Needs human attention
        </Badge>
      ) : null}
      <div className="flex w-full items-center gap-3 rounded-md border bg-muted/40 px-3 py-2">
        {steps.map((step, i) => (
          <div key={step.label} className="flex items-center">
            {i > 0 ? (
              <div
                aria-hidden
                className={cn('h-0.5 w-5 shrink-0', steps[i - 1]!.state === 'done' ? 'bg-live' : 'bg-border')}
              />
            ) : null}
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                  step.state === 'done'
                    ? 'bg-live text-background'
                    : step.state === 'active'
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-border bg-background text-muted-foreground',
                )}
              >
                {step.state === 'done' ? <Check className="size-3" /> : i + 1}
              </span>
              <span className="text-xs font-medium">{step.label}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function IssueRunPanel({
  group,
  missionId,
  ledgersByTaskId,
  taskRollupsByTaskId,
  onActiveTaskChange,
}: {
  group: IssueGroup;
  missionId: string;
  ledgersByTaskId: Record<string, LedgerRow[]>;
  taskRollupsByTaskId: Record<string, TaskRollup>;
  /** Reports the task whose file list and log should render in
   *  WorkspaceList's own persistent panels — see WorkspaceList. */
  onActiveTaskChange: (info: ActiveTaskInfo | null) => void;
}) {
  const [attemptIndex, setAttemptIndex] = useState(group.attempts.length);
  const [stage, setStage] = useState<'reproduce' | 'fix'>('fix');
  const [pending, startTransition] = useTransition();
  const [abortError, setAbortError] = useState<string | null>(null);

  const attempt = group.attempts.find((a) => a.index === attemptIndex) ?? group.attempts.at(-1);

  const effectiveStage = attempt?.fix ? stage : 'reproduce';
  const task = attempt ? (effectiveStage === 'reproduce' ? attempt.reproduce : attempt.fix) : null;
  const ledger = task ? (ledgersByTaskId[task.id] ?? []) : [];
  const rollup = task ? taskRollupsByTaskId[task.id] : undefined;
  const isLive = task ? RUNNING_STATUSES.has(task.status) : false;
  const assistantMessage = lastAssistantMessage(ledger);
  const mergeStepper = task ? deriveMergeStepper(task.status, task.prUrl) : { kind: 'hidden' as const };
  const started = formatStarted(task);
  const canAbort = !!task && ABORTABLE_STATUSES.has(task.status);
  const canSteer = !!task && !!task.sessionId && ABORTABLE_STATUSES.has(task.status);

  const prChips = group.attempts.map((a) => a.fix).filter((f): f is Task => !!f?.prUrl);

  useEffect(() => {
    onActiveTaskChange(task ? { task, ledger, isLive, mergeStepper } : null);
    return () => onActiveTaskChange(null);
    // Only re-notify when the active task, its status (which drives the
    // merge stepper shown in the parent's header), or its live-ness
    // actually changes — `ledger`/`onActiveTaskChange` are fresh references
    // every render and would otherwise re-fire this on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.status, isLive]);

  if (!attempt) return <p className="text-xs text-muted-foreground">No attempts yet.</p>;

  function handleAbort() {
    if (!task) return;
    setAbortError(null);
    startTransition(async () => {
      const result = await abortTask(task.id);
      if (!result.ok) setAbortError(result.error);
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-col gap-3">
        {prChips.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {prChips.map((f) => (
              <PrChip key={f.id} prUrl={f.prUrl!} prNumber={f.prNumber} status={f.status} />
            ))}
          </div>
        ) : null}

        {assistantMessage ? (
          <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
            <MarkdownMessage>{assistantMessage}</MarkdownMessage>
          </div>
        ) : null}

        {group.attempts.length > 1 ? (
          <Tabs value={String(attemptIndex)} onValueChange={(v) => setAttemptIndex(Number(v))}>
            <TabsList>
              {group.attempts.map((a) => (
                <TabsTrigger key={a.index} value={String(a.index)}>
                  Attempt {a.index}
                  {a.index === group.attempts.length ? ' ●' : ''}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}

        <StageStepper
          reproduce={attempt.reproduce}
          fix={attempt.fix}
          activeStage={effectiveStage}
          onStageChange={setStage}
        />

        {task ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-3">
              {started ? <span>Started {started}</span> : null}
              {rollup ? <TaskProgressPill rollup={rollup} variant="expanded" /> : null}
            </div>
            {canAbort ? (
              <Button
                variant="outline"
                size="sm"
                className="h-6 border-destructive/40 px-2 text-[11px] text-destructive hover:bg-destructive/10"
                onClick={handleAbort}
                disabled={pending}
              >
                {pending ? <Spinner data-icon="inline-start" /> : null}
                Abort
              </Button>
            ) : null}
          </div>
        ) : null}
        {abortError ? <p className="text-xs text-destructive">{abortError}</p> : null}
      </div>

      {task ? (
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-3">
          {canSteer ? <SteerInput key={task.id} taskId={task.id} /> : null}

          <Link
            href={`/missions/${missionId}/tasks/${task.id}`}
            className="inline-block shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            View full run →
          </Link>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">This stage hasn&apos;t started.</p>
      )}
    </div>
  );
}
