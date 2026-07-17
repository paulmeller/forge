import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BudgetGauge } from '@/components/budget-gauge';
import { MissionStatusBadge } from '@/components/mission-status-badge';
import { LiveRefresh } from '@/components/live-refresh';
import { TaskCard } from '@/components/task-card';
import { TemplateText } from '@/components/template-text';
import { listLedgerForMission } from '@/lib/ledger';
import { getMission } from '@/lib/missions';
import { getSkill, getSkillBySlug } from '@/lib/skills';
import { rollupTasks, tokensToUsd } from '@/lib/rollups';
import { listTasksForMission } from '@/lib/tasks';

import { MissionActionButton } from './mission-actions';
import { TimelineClient } from './timeline-client';

export const dynamic = 'force-dynamic';

export default async function MissionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ missionId: string }>;
  searchParams: Promise<{ task?: string }>;
}) {
  const { missionId } = await params;
  const { task: selectedTaskId } = await searchParams;

  const mission = await getMission(missionId);
  if (!mission) notFound();

  const tasks = await listTasksForMission(missionId);
  const [taskRollups, ledger] = await Promise.all([
    rollupTasks(tasks.map((t) => t.id)),
    listLedgerForMission(missionId, 500),
  ]);

  const skill = mission.skillId ? await getSkill(mission.skillId) : null;
  // Triage Missions attach their playbooks by Task kind, not via mission.skillId.
  const triageSkills =
    mission.plannerStrategy === 'triage'
      ? (await Promise.all([getSkillBySlug('bug-reproduce'), getSkillBySlug('bug-fix')])).filter(
          (s): s is NonNullable<typeof s> => s !== null,
        )
      : [];
  const targetRepos = mission.targetRepos ?? [];
  const totalSpentUsd = tokensToUsd(mission.spentTokens || 0);

  return (
    <main className="flex h-full flex-col overflow-hidden px-6 py-4">
      {/* Header */}
      <div className="mb-6 shrink-0">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
          <Link href="/missions">← All missions</Link>
        </Button>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{mission.name}</h1>
              <MissionStatusBadge status={mission.status} />
            </div>
            <div className="mt-1 flex items-center gap-2">
              <p className="font-mono text-[11px] text-muted-foreground">{mission.id}</p>
              {mission.status === 'running' || mission.status === 'planning' ? (
                <LiveRefresh intervalMs={5000} />
              ) : null}
            </div>
          </div>
          <div className="flex items-start gap-2">
            {mission.plannerStrategy === 'triage' ? (
              <Button asChild variant="outline">
                <Link href={`/missions/${mission.id}/issues`}>View by issue →</Link>
              </Button>
            ) : null}
            {mission.status === 'draft'
              ? (() => {
                  const isTriage = mission.plannerStrategy === 'triage';
                  const missingSource = isTriage
                    ? !mission.issueQuery?.trim()
                    : targetRepos.length === 0;
                  return (
                    <MissionActionButton
                      missionId={mission.id}
                      op="plan"
                      label="Plan Mission"
                      pendingLabel="Planning…"
                      disabled={missingSource}
                      disabledReason={
                        missingSource
                          ? isTriage
                            ? 'Add an issue search query first'
                            : 'Add target repos first'
                          : undefined
                      }
                    />
                  );
                })()
              : null}
            {mission.status === 'planning' ? (
              <>
                <Button asChild variant="outline">
                  <Link href={`/missions/${mission.id}/plan`}>Review plan →</Link>
                </Button>
                <MissionActionButton
                  missionId={mission.id}
                  op="start"
                  label="Start Mission"
                  pendingLabel="Starting…"
                  disabled={tasks.length === 0}
                  disabledReason={tasks.length === 0 ? 'No Tasks to dispatch' : undefined}
                />
              </>
            ) : null}
            {mission.status === 'running' ? (
              <MissionActionButton
                missionId={mission.id}
                op="pause"
                label="Pause"
                pendingLabel="Pausing…"
                variant="outline"
              />
            ) : null}
            {mission.status === 'paused' ? (
              <MissionActionButton
                missionId={mission.id}
                op="resume"
                label="Resume"
                pendingLabel="Resuming…"
              />
            ) : null}
          </div>
        </div>
      </div>

      {/* Top two-thirds: Tasks + Sidebar (own scroll) / bottom third: Timeline console */}
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <div className="min-h-0 min-w-0 flex-[2] overflow-y-auto">
          <div className="grid min-w-0 grid-cols-12 gap-6">
            {/* Left: Tasks */}
            <section className="col-span-12 min-w-0 lg:col-span-8">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Tasks {tasks.length > 0 && <span className="font-normal">({tasks.length})</span>}
              </h2>
              {tasks.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6">
                  {targetRepos.length > 0 && mission.status === 'draft' ? (
                    <>
                      <p className="mb-2 text-xs text-muted-foreground">
                        Planner will emit one Task per repo:
                      </p>
                      <ul className="space-y-1 font-mono text-[11px]">
                        {targetRepos.map((repo) => (
                          <li key={repo}>{repo}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">No Tasks yet.</p>
                  )}
                </div>
              ) : (
                <ol className="space-y-2">
                  {tasks.map((t) => (
                    <li key={t.id}>
                      <TaskCard
                        task={t}
                        rollup={
                          taskRollups.get(t.id) ?? {
                            toolCalls: 0,
                            toolResults: 0,
                            costTokens: t.costTokens,
                            startedAt: t.dispatchedAt,
                            endedAt: t.completedAt,
                          }
                        }
                        missionId={mission.id}
                      />
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {/* Right: Sidebar */}
            <aside className="col-span-12 min-w-0 space-y-4 lg:col-span-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Goal</CardTitle>
                </CardHeader>
                <CardContent>
                  <TemplateText text={mission.goal} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Budget</CardTitle>
                </CardHeader>
                <CardContent>
                  <BudgetGauge
                    spentUsd={totalSpentUsd}
                    budgetUsd={mission.budgetUsd}
                    spentTokens={mission.spentTokens}
                    budgetTokens={mission.budgetTokens}
                    thresholdPct={mission.budgetThresholdPct}
                  />
                </CardContent>
              </Card>

              {triageSkills.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Triage skills</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    <p className="text-[11px] text-muted-foreground">
                      Attached per Task kind — reproduce and fix run different playbooks.
                    </p>
                    {triageSkills.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center justify-between gap-2 border-b py-1"
                      >
                        <span className="font-mono">{s.name}</span>
                        {s.allowedTools && (
                          <span className="text-muted-foreground">
                            {s.allowedTools.length} tools
                          </span>
                        )}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {skill && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Skill</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 text-xs">
                    <Row label="Name" value={skill.name} />
                    <Row label="Version" value={skill.version} mono />
                    {skill.allowedTools && (
                      <Row label="Tools" value={`${skill.allowedTools.length} allowed`} />
                    )}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground">
                        View raw
                      </summary>
                      <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px] leading-tight">
                        {skill.promptTemplate}
                      </pre>
                    </details>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Execution</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-xs">
                  <Link
                    href={`/missions/${mission.id}/ledger`}
                    className="block border-b py-1.5 text-muted-foreground underline decoration-dotted hover:text-foreground"
                  >
                    View full Ledger &rarr;
                  </Link>
                  <Row label="Backend" value={mission.backend} mono />
                  <Row label="Agent" value={mission.agentId} mono />
                  <Row label="Planner" value={mission.plannerStrategy} />
                  <Row label="Concurrency" value={mission.concurrencyCap} />
                  <Row label="Repos" value={targetRepos.length} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">GitHub</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-xs">
                  <Row
                    label="Install"
                    value={mission.githubInstallationId ?? '—'}
                    mono={!!mission.githubInstallationId}
                  />
                  <Row
                    label="MCP vault"
                    value={mission.githubVaultId ?? '—'}
                    mono={!!mission.githubVaultId}
                  />
                </CardContent>
              </Card>

              {(mission.status === 'completed' || mission.status === 'cancelled') && (
                <Card>
                  <CardContent className="py-3">
                    <Link
                      href={`/missions/${mission.id}/retrospective`}
                      className="text-xs text-muted-foreground underline decoration-dotted hover:text-foreground"
                    >
                      Retrospective &rarr;
                    </Link>
                  </CardContent>
                </Card>
              )}
            </aside>
          </div>
        </div>

        {/* Timeline — tailed console, bottom third */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="mb-2 flex shrink-0 items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Timeline {ledger.length > 0 && <span className="font-normal">({ledger.length} events)</span>}
            </h2>
            <Link
              href={`/missions/${mission.id}/ledger`}
              className="text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
            >
              Full ledger &rarr;
            </Link>
          </div>
          <TimelineClient
            events={ledger}
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            missionId={mission.id}
          />
        </section>
      </div>
    </main>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b py-1.5 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'truncate font-mono' : 'truncate'}>{value}</dd>
    </div>
  );
}
