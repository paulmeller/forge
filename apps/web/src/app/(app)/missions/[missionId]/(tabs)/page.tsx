import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { BudgetGauge } from '@/components/budget-gauge';
import { TaskCard } from '@/components/task-card';
import { TemplateText } from '@/components/template-text';
import { listLedgerForMission } from '@/lib/ledger';
import { getMission } from '@/lib/missions';
import { getSkill, getSkillBySlug } from '@/lib/skills';
import { rollupTasks, tokensToUsd } from '@/lib/rollups';
import { listTasksForMission } from '@/lib/tasks';

import { TimelineClient } from '../timeline-client';

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
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <div className="min-h-0 min-w-0 flex-[2] overflow-y-auto">
        <div className="grid min-w-0 grid-cols-12 gap-6">
          {/* Left: Tasks */}
          <section className="rise rise-1 col-span-12 min-w-0 lg:col-span-8">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Tasks {tasks.length > 0 && <span className="font-normal">({tasks.length})</span>}
            </h2>
            {tasks.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle>
                    {targetRepos.length > 0 && mission.status === 'draft'
                      ? 'Planner will emit one Task per repo:'
                      : 'No Tasks yet.'}
                  </EmptyTitle>
                </EmptyHeader>
                {targetRepos.length > 0 && mission.status === 'draft' ? (
                  <EmptyContent>
                    <ul className="flex flex-col gap-1 font-mono text-[11px]">
                      {targetRepos.map((repo) => (
                        <li key={repo}>{repo}</li>
                      ))}
                    </ul>
                  </EmptyContent>
                ) : null}
              </Empty>
            ) : (
              <ol className="flex flex-col gap-2">
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
          <aside className="rise rise-2 col-span-12 flex min-w-0 flex-col gap-4 lg:col-span-4">
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
                <CardContent className="flex flex-col gap-2 text-xs">
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
                        <span className="text-muted-foreground">{s.allowedTools.length} tools</span>
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
                <CardContent className="flex flex-col gap-1 text-xs">
                  <Row label="Name" value={skill.name} />
                  <Row label="Version" value={skill.version} mono />
                  {skill.allowedTools && (
                    <Row label="Tools" value={`${skill.allowedTools.length} allowed`} />
                  )}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
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
              <CardContent className="flex flex-col gap-1 text-xs">
                <Link
                  href={`/missions/${mission.id}/ledger`}
                  className="block border-b py-1.5 text-muted-foreground underline underline-offset-2 hover:text-foreground"
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
              <CardContent className="flex flex-col gap-1 text-xs">
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
                    className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
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
      <section className="rise rise-3 flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="mb-2 flex shrink-0 items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Timeline{' '}
            {ledger.length > 0 && <span className="font-normal">({ledger.length} events)</span>}
          </h2>
          <Link
            href={`/missions/${mission.id}/ledger`}
            className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
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
