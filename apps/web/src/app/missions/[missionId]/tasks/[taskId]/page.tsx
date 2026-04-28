import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getMission } from '@/lib/missions';
import { getTask } from '@/lib/tasks';
import { listLedgerForTask } from '@/lib/ledger';

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

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).format(date);
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
    <main className="container max-w-4xl py-10">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4">
        <Link href={`/missions/${mission.id}`}>← {mission.name}</Link>
      </Button>

      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl font-semibold">{task.repo}</h1>
            <Badge variant={taskStatusVariant[task.status] ?? 'outline'}>{task.status}</Badge>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{task.id}</p>
        </div>
        {task.prUrl ? (
          <Button asChild variant="outline">
            <a href={task.prUrl} target="_blank" rel="noopener noreferrer">
              View PR #{task.prNumber ?? ''}
            </a>
          </Button>
        ) : null}
      </div>

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
              <Row label="Cost (tokens)" value={new Intl.NumberFormat().format(task.costTokens)} />
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
              <Row label="Created" value={formatDate(task.createdAt)} />
              <Row
                label="Dispatched"
                value={task.dispatchedAt ? formatDate(task.dispatchedAt) : '—'}
              />
              <Row
                label="Completed"
                value={task.completedAt ? formatDate(task.completedAt) : '—'}
              />
              <Row label="Updated" value={formatDate(task.updatedAt)} />
            </dl>
          </CardContent>
        </Card>
      </div>

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
            <ol className="space-y-3">
              {ledger.map((event) => (
                <li key={event.id} className="rounded-md border p-3">
                  <div className="flex items-baseline justify-between gap-4">
                    <div className="font-mono text-xs font-semibold">{event.eventType}</div>
                    <div className="text-xs text-muted-foreground">{formatDate(event.createdAt)}</div>
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
    </main>
  );
}
