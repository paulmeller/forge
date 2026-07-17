'use client';

import { useState } from 'react';
import Link from 'next/link';

import { SessionLogView } from '@/components/session-log-view';
import { TaskStatusBadge } from '@/components/task-status-badge';
import type { IssueGroup } from '@/lib/triage-view';

type LedgerRow = { id: string; eventType: string; payload: unknown; createdAt: Date };

const RUNNING_STATUSES = new Set(['queued', 'dispatching', 'running']);

export function IssueRunPanel({
  group,
  missionId,
  reproduceLedger,
  fixLedger,
}: {
  group: IssueGroup;
  missionId: string;
  reproduceLedger: LedgerRow[];
  fixLedger: LedgerRow[];
}) {
  const latest = group.attempts.at(-1) ?? null;
  const [stage, setStage] = useState<'reproduce' | 'fix'>(
    latest?.fix ? 'fix' : 'reproduce',
  );

  const task = stage === 'reproduce' ? (latest?.reproduce ?? null) : (latest?.fix ?? null);
  const ledger = stage === 'reproduce' ? reproduceLedger : fixLedger;
  const isLive = task ? RUNNING_STATUSES.has(task.status) : false;
  const verdict = latest?.reproduce?.verdict ?? null;

  return (
    <div className="space-y-3">
      {verdict?.summary ? (
        <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
          {verdict.summary}
        </p>
      ) : null}

      <div className="flex gap-1 border-b">
        {(['reproduce', 'fix'] as const).map((key) => {
          const t = key === 'reproduce' ? (latest?.reproduce ?? null) : (latest?.fix ?? null);
          return (
            <button
              key={key}
              type="button"
              onClick={() => setStage(key)}
              className={`px-3 py-1.5 text-xs font-medium capitalize ${
                stage === key
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {key}
              {t ? (
                <span className="ml-1.5 inline-block align-middle">
                  <TaskStatusBadge status={t.status} haltReason={t.haltReason} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {task ? (
        <>
          <SessionLogView
            taskId={task.id}
            isLive={isLive}
            initialEvents={ledger}
            maxLines={15}
            className="h-[200px]"
          />
          <Link
            href={`/missions/${missionId}/tasks/${task.id}`}
            className="inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
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
