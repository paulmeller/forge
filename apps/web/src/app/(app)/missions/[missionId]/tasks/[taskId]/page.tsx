import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader, PageShell } from '@/components/page-shell';
import { SessionLogView } from '@/components/session-log-view';
import { SteerInput } from '@/components/steer-input';
import { formatDateTime } from '@/lib/format';
import { getMission } from '@/lib/missions';
import { getTask } from '@/lib/tasks';
import { listLedgerForTask } from '@/lib/ledger';

import { TaskFileTabs } from './file-tabs';

export const dynamic = 'force-dynamic';

const taskStatusVariant: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  queued: 'outline',
  dispatching: 'secondary',
  running: 'default',
  turn_ended: 'secondary',
  opening_pr: 'secondary',
  awaiting_ci: 'secondary',
  awaiting_review: 'secondary',
  merging: 'default',
  merged: 'default',
  abandoned: 'outline',
  failed: 'destructive',
};

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-sm' : 'text-sm'}>{value}</dd>
    </div>
  );
}

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ missionId: string; taskId: string }>;
}) {
  const { missionId, taskId } = await params;
  const [mission, task] = await Promise.all([getMission(missionId), getTask(taskId)]);
  if (!mission || !task || task.missionId !== mission.id) notFound();

  const ledger = await listLedgerForTask(task.id, 200);

  return (
    <PageShell className="max-w-4xl">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4">
        <Link href={`/missions/${mission.id}`}>← {mission.name}</Link>
      </Button>

      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {task.repo}
            <span className="normal-case">
              <Badge variant={taskStatusVariant[task.status] ?? 'outline'}>{task.status}</Badge>
            </span>
          </span>
        }
        subtitle={<span className="font-mono text-xs">{task.id}</span>}
        actions={
          task.prUrl ? (
            <Button asChild variant="outline">
              <a href={task.prUrl} target="_blank" rel="noopener noreferrer">
                View PR #{task.prNumber ?? ''}
              </a>
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Task</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Row label="Repo" value={task.repo} mono />
              <Row label="Base branch" value={task.baseBranch} mono />
              <Row label="Session" value={task.sessionId ?? '—'} mono={!!task.sessionId} />
              <Row label="Retry count" value={task.retryCount} />
              <Row label="Cost (tokens)" value={new Intl.NumberFormat('en-US').format(task.costTokens)} />
              {task.lastError ? (
                <Row
                  label="Last error"
                  value={<span className="text-destructive">{task.lastError}</span>}
                />
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Row label="Created" value={formatDateTime(task.createdAt, { seconds: true })} />
              <Row
                label="Dispatched"
                value={task.dispatchedAt ? formatDateTime(task.dispatchedAt, { seconds: true }) : '—'}
              />
              <Row
                label="Completed"
                value={task.completedAt ? formatDateTime(task.completedAt, { seconds: true }) : '—'}
              />
              <Row label="Updated" value={formatDateTime(task.updatedAt, { seconds: true })} />
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Run</CardTitle>
          <CardDescription>
            prompt.txt, agent.log, and status.json are Forge-captured data presented as
            files — not a view of the actual sandbox filesystem.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <TaskFileTabs
            promptVars={task.promptVars as Record<string, unknown> | null}
            status={task.status}
            verdict={task.verdict}
            ledger={ledger}
          />
          <SessionLogView
            taskId={task.id}
            isLive={['queued', 'dispatching', 'running'].includes(task.status)}
            initialEvents={[...ledger].reverse()}
            className="h-[400px]"
          />
          {task.sessionId &&
          ['dispatching', 'running', 'turn_ended', 'opening_pr'].includes(task.status) ? (
            <SteerInput taskId={task.id} />
          ) : null}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Ledger</CardTitle>
          <CardDescription>
            Every event recorded for this Task, newest first. Backend-sourced events carry a{' '}
            <span className="font-mono">source_event_id</span>; Forge-written events do not.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ledger.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events yet.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {ledger.map((event) => (
                <li key={event.id} className="rounded-md border p-3">
                  <div className="flex items-baseline justify-between gap-4">
                    <div className="font-mono text-xs font-semibold">{event.eventType}</div>
                    <div className="text-xs text-muted-foreground">{formatDateTime(event.createdAt, { seconds: true })}</div>
                  </div>
                  {event.sourceEventId ? (
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                      {event.sourceEventId}
                    </p>
                  ) : null}
                  {event.payload && Object.keys(event.payload).length > 0 ? (
                    <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-[11px] leading-relaxed">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
