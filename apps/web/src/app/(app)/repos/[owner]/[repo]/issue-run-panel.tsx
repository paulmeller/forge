'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PrChip } from '@/components/pr-chip';
import { TaskProgressPill, type TaskRollup } from '@/components/progress-pill';
import { SessionLogView } from '@/components/session-log-view';
import { SteerInput } from '@/components/steer-input';
import { TaskStatusBadge } from '@/components/task-status-badge';
import { Spinner } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format';
import type { IssueGroup } from '@/lib/triage-view';
import type { Task } from '@forge/db';

import { abortTask } from './actions';
import { AttemptFileBrowser } from './attempt-file-browser';

type LedgerRow = { id: string; eventType: string; payload: unknown; createdAt: Date };

const RUNNING_STATUSES = new Set(['queued', 'dispatching', 'running']);
const ABORTABLE_STATUSES = new Set(['dispatching', 'running', 'turn_ended', 'opening_pr']);

function formatStarted(task: Task | null): string | null {
  const at = task?.dispatchedAt ?? task?.createdAt ?? null;
  if (!at) return null;
  return formatDateTime(at, { seconds: true });
}

export function IssueRunPanel({
  group,
  missionId,
  ledgersByTaskId,
  taskRollupsByTaskId,
}: {
  group: IssueGroup;
  missionId: string;
  ledgersByTaskId: Record<string, LedgerRow[]>;
  taskRollupsByTaskId: Record<string, TaskRollup>;
}) {
  const [attemptIndex, setAttemptIndex] = useState(group.attempts.length);
  const [stage, setStage] = useState<'reproduce' | 'fix'>('fix');
  const [pending, startTransition] = useTransition();
  const [abortError, setAbortError] = useState<string | null>(null);

  const attempt = group.attempts.find((a) => a.index === attemptIndex) ?? group.attempts.at(-1);
  if (!attempt) return <p className="text-xs text-muted-foreground">No attempts yet.</p>;

  const effectiveStage = attempt.fix ? stage : 'reproduce';
  const task = effectiveStage === 'reproduce' ? attempt.reproduce : attempt.fix;
  const ledger = task ? (ledgersByTaskId[task.id] ?? []) : [];
  const rollup = task ? taskRollupsByTaskId[task.id] : undefined;
  const isLive = task ? RUNNING_STATUSES.has(task.status) : false;
  const verdict = attempt.reproduce?.verdict ?? null;
  const started = formatStarted(task);
  const canAbort = !!task && ABORTABLE_STATUSES.has(task.status);
  const canSteer = !!task && !!task.sessionId && ABORTABLE_STATUSES.has(task.status);

  const prChips = group.attempts
    .map((a) => a.fix)
    .filter((f): f is Task => !!f?.prUrl);

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

        {verdict?.summary ? (
          <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
            {verdict.summary}
          </p>
        ) : null}

        {group.attempts.length > 1 ? (
          <Tabs
            value={String(attemptIndex)}
            onValueChange={(v) => setAttemptIndex(Number(v))}
          >
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

        <Tabs
          value={effectiveStage}
          onValueChange={(v) => setStage(v as 'reproduce' | 'fix')}
        >
          <TabsList>
            {(['reproduce', 'fix'] as const).map((key) => {
              const t = key === 'reproduce' ? attempt.reproduce : attempt.fix;
              return (
                <TabsTrigger key={key} value={key} className="capitalize">
                  {key}
                  {t ? (
                    <span className="ml-1.5 inline-block align-middle">
                      <TaskStatusBadge status={t.status} haltReason={t.haltReason} />
                    </span>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>

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
        <>
          <div className="min-h-0 min-w-0 flex-[2] overflow-y-auto">
            <AttemptFileBrowser task={task} ledger={ledger} />
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <SessionLogView
              taskId={task.id}
              isLive={isLive}
              initialEvents={ledger}
              maxLines={300}
              className="h-full"
            />
          </div>

          {canSteer && task ? <SteerInput key={task.id} taskId={task.id} /> : null}

          <Link
            href={`/missions/${missionId}/tasks/${task.id}`}
            className="inline-block shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            View full run →
          </Link>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">This stage hasn&apos;t started.</p>
      )}
    </div>
  );
}
