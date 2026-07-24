import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from '@forge/db/orm';

import { githubInstallations } from '@forge/db';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader, PageShell } from '@/components/page-shell';
import { QueueSection } from '@/components/queue-section';
import { db } from '@/lib/db';
import { getDashboardStats, getNeedsYou, getNowRunning, getRecentOutcomes } from '@/lib/home';
import { rollupTasks } from '@/lib/rollups';
import { withAuth } from '@/lib/with-auth';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await withAuth();

  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, user.id))
    .limit(1);
  if (!installation) redirect('/setup');

  const [stats, needsYou, nowRunning, recentOutcomes] = await Promise.all([
    getDashboardStats(user.id),
    getNeedsYou(user.id),
    getNowRunning(user.id),
    getRecentOutcomes(user.id),
  ]);
  const runningRollups = await rollupTasks(nowRunning.map((r) => r.task.id));

  return (
    <PageShell>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Home
            {nowRunning.length > 0 ? (
              <span className="normal-case">
                <LiveRefresh intervalMs={5000} />
              </span>
            ) : null}
          </span>
        }
        subtitle={`What needs you, what's running, what just landed.`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/missions">View all missions →</Link>
          </Button>
        }
      />

      {stats.connectedRepos === 0 && (
        <Alert className="mb-8 flex items-center justify-between gap-4 border-dashed border-warning/40 text-foreground">
          <div>
            <AlertTitle className="text-sm">Connect your repos to get started</AlertTitle>
            <AlertDescription className="text-xs text-muted-foreground">
              Install the GitHub App and select repos. Then comment{' '}
              <code className="rounded bg-muted px-1 py-0.5">@forge</code> on any issue.
            </AlertDescription>
          </div>
          <Button asChild size="sm">
            <Link href="/setup">Connect Repos</Link>
          </Button>
        </Alert>
      )}

      <div className="rise rise-1 mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Link href="/missions?status=completed" className="block">
          <Card className="px-4 py-3 transition-colors hover:bg-accent">
            <p className="text-4xl font-semibold tabular-nums">{stats.mergedThisWeek}</p>
            <p className="text-xs text-muted-foreground">PRs merged this week</p>
          </Card>
        </Link>
        <Link href="/missions?status=running" className="block">
          <Card className="px-4 py-3 transition-colors hover:bg-accent">
            <p className="text-4xl font-semibold tabular-nums">{stats.activeAgents}</p>
            <p className="text-xs text-muted-foreground">Active agents</p>
          </Card>
        </Link>
        <Link href="/missions" className="block">
          <Card className="px-4 py-3 transition-colors hover:bg-accent">
            <p className="text-4xl font-semibold tabular-nums">${stats.spentUsd.toFixed(2)}</p>
            <p className="text-xs text-muted-foreground">Total spend</p>
          </Card>
        </Link>
        <Link href="/repos" className="block">
          <Card className="px-4 py-3 transition-colors hover:bg-accent">
            <p className="text-4xl font-semibold tabular-nums">{stats.connectedRepos}</p>
            <p className="text-xs text-muted-foreground">Connected repos</p>
          </Card>
        </Link>
      </div>

      <div className="flex flex-col gap-6">
        <div className="rise rise-2">
          <QueueSection title="Needs you" rows={needsYou} empty="Nothing waiting on you." />
        </div>
        <div className="rise rise-3">
          <QueueSection
            title="Working"
            rows={nowRunning}
            rollups={runningRollups}
            empty="Nothing running right now."
            live
          />
        </div>
        <div className="rise rise-4">
          <QueueSection
            title="Recently done"
            rows={recentOutcomes}
            empty="No merged PRs or resolved issues yet."
          />
        </div>
      </div>
    </PageShell>
  );
}
