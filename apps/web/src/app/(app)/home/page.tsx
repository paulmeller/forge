import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from '@forge/db/orm';

import { githubInstallations } from '@forge/db';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TaskStatusBadge } from '@/components/task-status-badge';
import { db } from '@/lib/db';
import {
  getNeedsYou,
  getNowRunning,
  getRecentOutcomes,
  getRepoActivity,
  type HomeTaskRow,
} from '@/lib/home';
import { withAuth } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

function TaskRow({ row }: { row: HomeTaskRow }) {
  const { task, missionName, isStanding } = row;
  const label = task.issueRef ?? missionName;
  return (
    <Link
      href={`/missions/${task.missionId}/tasks/${task.id}`}
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm hover:bg-accent"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{label}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{task.repo}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isStanding ? (
          <Badge variant="outline" className="text-[10px]">
            Standing
          </Badge>
        ) : null}
        <TaskStatusBadge status={task.status} haltReason={task.haltReason} />
      </div>
    </Link>
  );
}

function Section({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: HomeTaskRow[];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          rows.map((row) => <TaskRow key={row.task.id} row={row} />)
        )}
      </CardContent>
    </Card>
  );
}

export default async function HomePage() {
  const user = await withAuth();

  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, user.id))
    .limit(1);
  if (!installation) redirect('/setup');

  const [nowRunning, needsYou, recentOutcomes, repoActivity] = await Promise.all([
    getNowRunning(user.id),
    getNeedsYou(user.id),
    getRecentOutcomes(user.id),
    getRepoActivity(user.id),
  ]);

  return (
    <main className="container max-w-[1400px] py-10">
      <div className="mb-8">
        <h1 className="font-title text-3xl uppercase tracking-tight">Home</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything running across your repos and missions.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title="Now running" rows={nowRunning} empty="Nothing running right now." />
        <Section title="Needs you" rows={needsYou} empty="Nothing waiting on you." />
        <Section
          title="Recent outcomes"
          rows={recentOutcomes}
          empty="No merged PRs or resolved issues yet."
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your repos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {repoActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No repos connected yet.{' '}
                <Link href="/setup" className="underline underline-offset-2">
                  Connect repos in Setup
                </Link>
                .
              </p>
            ) : (
              repoActivity.map(({ repo, activeCount, totalCount }) => {
                const [owner, name] = repo.split('/');
                return (
                  <Link
                    key={repo}
                    href={`/repos/${owner}/${name}`}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 font-mono text-sm hover:bg-accent"
                  >
                    <span className="truncate">{repo}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {activeCount > 0 ? `${activeCount} active · ` : ''}
                      {totalCount} total
                    </span>
                  </Link>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
