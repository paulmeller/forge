import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { ConsoleShell } from '@/components/console-shell';
import { HeaderPortal } from '@/components/header-portal';
import { LiveRefresh } from '@/components/live-refresh';
import { PageShell } from '@/components/page-shell';
import { RepoBudgetLine } from '@/components/repo-budget-line';
import { env } from '@/lib/env';
import { listLedgerForTask } from '@/lib/ledger';
import { getRepoBudget } from '@/lib/repo-budget';
import { listTasksTouchingRepo } from '@/lib/repo-activity';
import { rollupTasks } from '@/lib/rollups';
import { listTasksForWorkspace } from '@/lib/tasks';
import { githubSearchIssues } from '@/lib/triage-planner';
import { groupTasksByIssue } from '@/lib/triage-view';
import { withAuth } from '@/lib/with-auth';
import { findWorkspaceMission } from '@/lib/workspace-mission';
import { mergeIssuesWithGroups } from '@/lib/workspace-issues';

const RUNNING_TASK_STATUSES = new Set(['queued', 'dispatching', 'running']);

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
  searchParams: Promise<{ tab?: string; issue?: string }>;
}) {
  const { owner, repo: repoName } = await params;
  const { tab, issue } = await searchParams;
  const initialIssueNumber = issue && /^\d+$/.test(issue) ? Number(issue) : null;
  const activeTab = tab === 'activity' ? 'activity' : tab === 'settings' ? 'settings' : 'issues';
  const repo = `${owner}/${repoName}`;
  const user = await withAuth();

  if (!env.GITHUB_APP_TOKEN) {
    return (
      <PageShell className="max-w-3xl">
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>
              Issue search needs a <code className="font-mono">GITHUB_APP_TOKEN</code> configured
              on the server. Ask an operator to set it, then reload this page.
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      </PageShell>
    );
  }

  let search;
  try {
    search = await githubSearchIssues(`repo:${repo} is:issue is:open`);
  } catch (err) {
    return (
      <PageShell className="max-w-3xl">
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
          Couldn&apos;t load issues from GitHub:{' '}
          {err instanceof Error ? err.message : 'unknown error'}
        </div>
      </PageShell>
    );
  }

  const mission = await findWorkspaceMission(user.id, repo);
  const repoBudget = await getRepoBudget(user.id, repo);
  const tasks = mission ? await listTasksForWorkspace(mission.id) : [];
  const groups = groupTasksByIssue(tasks);
  const rows = mergeIssuesWithGroups(search.issues, groups);

  const allTaskIds = rows.flatMap((row) =>
    (row.group?.attempts ?? []).flatMap((a) =>
      [a.reproduce?.id, a.fix?.id].filter((id): id is string => !!id),
    ),
  );

  const ledgersByTaskIdMap = new Map<string, Awaited<ReturnType<typeof listLedgerForTask>>>();
  await Promise.all(
    allTaskIds.map(async (id) => {
      ledgersByTaskIdMap.set(id, [...(await listLedgerForTask(id, 200))].reverse());
    }),
  );
  const ledgersByTaskId = Object.fromEntries(ledgersByTaskIdMap);

  const taskRollupsMap = await rollupTasks(allTaskIds);
  const taskRollupsByTaskId = Object.fromEntries(taskRollupsMap);

  const hasActiveWork = rows.some((row) =>
    (row.group?.attempts ?? []).some(
      (a) =>
        (a.reproduce && RUNNING_TASK_STATUSES.has(a.reproduce.status)) ||
        (a.fix && RUNNING_TASK_STATUSES.has(a.fix.status)),
    ),
  );

  return (
    <ConsoleShell>
      <HeaderPortal>
        <RepoTabs active={activeTab} repo={repo} />
      </HeaderPortal>
      <div className="shrink-0">
        <div className="title-glow mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 title={repo} className="truncate font-mono text-2xl font-semibold tracking-tight">
                {repo}
              </h1>
              {hasActiveWork ? <LiveRefresh intervalMs={5000} /> : null}
            </div>
            <div className="mt-1 flex items-center gap-3">
              <p className="text-sm text-muted-foreground">
                {rows.length} open issue{rows.length === 1 ? '' : 's'}
              </p>
              <RepoBudgetLine budget={repoBudget} />
            </div>
          </div>
          <div className="flex shrink-0 items-start gap-2">
            <NewIssueDialog owner={owner} repo={repoName} />
            <RepoToolbar
              repo={repo}
              containerStatus={
                mission ? (mission.status === 'paused' ? 'paused' : 'running') : null
              }
              missionsHref={mission ? `/missions?repo=${encodeURIComponent(repo)}` : null}
            />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {activeTab === 'activity' ? (
          <div className="h-full overflow-y-auto">
            <ActivityTab rows={await listTasksTouchingRepo(user.id, repo)} />
          </div>
        ) : activeTab === 'settings' ? (
          <div className="h-full overflow-y-auto">
            {mission ? (
              <SettingsTab
                containerId={mission.id}
                concurrencyCap={mission.concurrencyCap}
                budgetUsd={mission.budgetUsd}
                aiReviewEnabled={mission.aiReviewEnabled}
                selfVerifyEnabled={mission.selfVerifyEnabled}
              />
            ) : (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle>No settings yet — work an issue in this repo first.</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        ) : (
          <WorkspaceList
            repo={repo}
            rows={rows}
            missionId={mission?.id ?? null}
            ledgersByTaskId={ledgersByTaskId}
            taskRollupsByTaskId={taskRollupsByTaskId}
            nextIssueRefs={mission?.nextIssueRefs ?? []}
            initialIssueNumber={initialIssueNumber}
          />
        )}
      </div>
    </ConsoleShell>
  );
}
