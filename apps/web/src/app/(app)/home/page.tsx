import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from '@forge/db/orm';

import { githubInstallations } from '@forge/db';

import { Button } from '@/components/ui/button';
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
    <PageShell className="py-10">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Home
            {nowRunning.length > 0 ? <LiveRefresh intervalMs={5000} /> : null}
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
        <div className="mb-8 rounded-lg border border-dashed border-yellow-600/40 bg-yellow-950/20 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Connect your repos to get started</p>
              <p className="text-xs text-muted-foreground">
                Install the GitHub App and select repos. Then comment{' '}
                <code className="rounded bg-muted px-1 py-0.5">@forge</code> on any issue.
              </p>
            </div>
            <Button asChild size="sm">
              <Link href="/setup">Connect Repos</Link>
            </Button>
          </div>
        </div>
      )}

      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-lg border px-4 py-3">
          <p className="text-2xl font-semibold">{stats.mergedThisWeek}</p>
          <p className="text-xs text-muted-foreground">PRs merged this week</p>
        </div>
        <div className="rounded-lg border px-4 py-3">
          <p className="text-2xl font-semibold">{stats.activeAgents}</p>
          <p className="text-xs text-muted-foreground">Active agents</p>
        </div>
        <div className="rounded-lg border px-4 py-3">
          <p className="text-2xl font-semibold">${stats.spentUsd.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">Total spend</p>
        </div>
        <div className="rounded-lg border px-4 py-3">
          <p className="text-2xl font-semibold">{stats.connectedRepos}</p>
          <p className="text-xs text-muted-foreground">Connected repos</p>
        </div>
      </div>

      <div className="space-y-6">
        <QueueSection
          title="Needs you"
          rows={needsYou}
          empty="Nothing waiting on you."
        />
        <QueueSection
          title="Working"
          rows={nowRunning}
          rollups={runningRollups}
          empty="Nothing running right now."
          live
        />
        <QueueSection
          title="Recently done"
          rows={recentOutcomes}
          empty="No merged PRs or resolved issues yet."
        />
      </div>
    </PageShell>
  );
}
