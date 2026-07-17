import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { env } from '@/lib/env';
import { listLedgerForTask } from '@/lib/ledger';
import { listTasksTouchingRepo } from '@/lib/repo-activity';
import { listTasksForWorkspace } from '@/lib/tasks';
import { githubSearchIssues } from '@/lib/triage-planner';
import { groupTasksByIssue } from '@/lib/triage-view';
import { withAuth } from '@/lib/with-auth';
import { findWorkspaceMission } from '@/lib/workspace-mission';
import { mergeIssuesWithGroups } from '@/lib/workspace-issues';

import { ActivityTab } from './activity-tab';
import { NewIssueDialog } from './new-issue-dialog';
import { RepoTabs } from './repo-tabs';
import { RepoToolbar } from './repo-toolbar';
import { SettingsTab } from './settings-tab';
import { WorkspaceList } from './workspace-list';

export const dynamic = 'force-dynamic';

export default async function RepoWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; repo: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { owner, repo: repoName } = await params;
  const { tab } = await searchParams;
  const activeTab = tab === 'activity' ? 'activity' : tab === 'settings' ? 'settings' : 'issues';
  const repo = `${owner}/${repoName}`;
  const user = await withAuth();

  if (!env.GITHUB_APP_TOKEN) {
    return (
      <main className="container max-w-3xl py-10">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4">
          <Link href="/repos">&larr; Repos</Link>
        </Button>
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          Issue search needs a <code className="font-mono">GITHUB_APP_TOKEN</code> configured on
          the server. Ask an operator to set it, then reload this page.
        </div>
      </main>
    );
  }

  let search;
  try {
    search = await githubSearchIssues(`repo:${repo} is:issue is:open`);
  } catch (err) {
    return (
      <main className="container max-w-3xl py-10">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4">
          <Link href="/repos">&larr; Repos</Link>
        </Button>
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
          Couldn&apos;t load issues from GitHub:{' '}
          {err instanceof Error ? err.message : 'unknown error'}
        </div>
      </main>
    );
  }

  const mission = await findWorkspaceMission(user.id, repo);
  const tasks = mission ? await listTasksForWorkspace(mission.id) : [];
  const groups = groupTasksByIssue(tasks);
  const rows = mergeIssuesWithGroups(search.issues, groups);

  const ledgersByTaskIdMap = new Map<string, Awaited<ReturnType<typeof listLedgerForTask>>>();
  await Promise.all(
    rows.flatMap((row) => {
      const ids = (row.group?.attempts ?? []).flatMap((a) =>
        [a.reproduce?.id, a.fix?.id].filter((id): id is string => !!id),
      );
      return ids.map(async (id) => {
        ledgersByTaskIdMap.set(id, [...(await listLedgerForTask(id, 200))].reverse());
      });
    }),
  );
  const ledgersByTaskId = Object.fromEntries(ledgersByTaskIdMap);

  return (
    <main className="container max-w-[1100px] py-8">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
        <Link href="/repos">&larr; Repos</Link>
      </Button>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{repo}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length} open issue{rows.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-2">
          <NewIssueDialog owner={owner} repo={repoName} />
          {mission ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/missions?repo=${encodeURIComponent(repo)}`}>View missions</Link>
            </Button>
          ) : null}
          <RepoToolbar
            repo={repo}
            containerStatus={
              mission ? (mission.status === 'paused' ? 'paused' : 'running') : null
            }
          />
        </div>
      </div>
      <RepoTabs active={activeTab} repo={repo} />

      {activeTab === 'activity' ? (
        <ActivityTab rows={await listTasksTouchingRepo(user.id, repo)} />
      ) : activeTab === 'settings' ? (
        mission ? (
          <SettingsTab
            containerId={mission.id}
            concurrencyCap={mission.concurrencyCap}
            budgetUsd={mission.budgetUsd}
            aiReviewEnabled={mission.aiReviewEnabled}
            selfVerifyEnabled={mission.selfVerifyEnabled}
          />
        ) : (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            No settings yet — work an issue in this repo first.
          </div>
        )
      ) : (
        <WorkspaceList
          repo={repo}
          rows={rows}
          missionId={mission?.id ?? null}
          ledgersByTaskId={ledgersByTaskId}
          nextIssueRefs={mission?.nextIssueRefs ?? []}
        />
      )}
    </main>
  );
}
