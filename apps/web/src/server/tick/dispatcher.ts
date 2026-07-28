import { randomUUID } from 'node:crypto';

import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type Mission, type Task, type TaskStatus } from '@forge/db';

import { getAdapter } from './adapters';
import { fetchAgentsMd } from './agents-md';
import { env } from '@/lib/env';
import { db } from '@/lib/db';
import { getRelevantMemories, formatMemoriesForPrompt } from './memory';
import { renderPrompt } from './prompt';
import { getSkill, getSkillBySlug } from './skill-loader';

export const INFLIGHT_STATUSES: TaskStatus[] = [
  'dispatching',
  'running',
  'turn_ended',
  'awaiting_ci',
  'awaiting_verify',
  'awaiting_ai_review',
  'ready_to_merge',
  'needs_human',
  'merging',
];

export type DispatchResult = {
  missions: number;
  claimed: number;
  dispatched: number;
  failed: number;
};

function gitIdentitySetup(): string {
  return (
    'Before making any git commits, run:\n' +
    `  git config --global user.name "${env.FORGE_GIT_AUTHOR_NAME}"\n` +
    `  git config --global user.email "${env.FORGE_GIT_AUTHOR_EMAIL}"`
  );
}

export async function runDispatcher(log: {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}): Promise<DispatchResult> {
  const runningMissions = await db.select().from(missions).where(eq(missions.status, 'running'));

  const parentIds = Array.from(
    new Set(runningMissions.map((m) => m.parentMissionId).filter((id): id is string => !!id)),
  );
  let containersById = new Map<string, Mission>();
  if (parentIds.length > 0) {
    const containerRows = await db.select().from(missions).where(inArray(missions.id, parentIds));
    containersById = new Map(containerRows.map((c) => [c.id, c]));
  }

  let siblingInflightByParentId = new Map<string, number>();
  if (parentIds.length > 0) {
    const rows = await db
      .select({ parentMissionId: missions.parentMissionId, count: sql<number>`count(*)` })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .where(
        and(inArray(missions.parentMissionId, parentIds), inArray(tasks.status, INFLIGHT_STATUSES)),
      )
      .groupBy(missions.parentMissionId);
    siblingInflightByParentId = new Map(
      rows
        .filter((r): r is typeof r & { parentMissionId: string } => !!r.parentMissionId)
        .map((r) => [r.parentMissionId, Number(r.count)]),
    );
  }
  const containerCaps = computeContainerCaps(runningMissions, containersById, siblingInflightByParentId);

  let totalClaimed = 0;
  let totalDispatched = 0;
  let totalFailed = 0;

  for (const mission of runningMissions) {
    const claimed = await claimNextBatch(mission, containerCaps.get(mission.id));
    totalClaimed += claimed.length;
    if (claimed.length === 0) continue;

    for (const task of claimed) {
      try {
        await dispatchOne(mission, task);
        totalDispatched += 1;
      } catch (err) {
        totalFailed += 1;
        const message = err instanceof Error ? err.message : String(err);
        log.error({ taskId: task.id, err: message }, 'dispatch:failed');
        await markFailed(task.id, message);
      }
    }
  }

  return {
    missions: runningMissions.length,
    claimed: totalClaimed,
    dispatched: totalDispatched,
    failed: totalFailed,
  };
}

/**
 * Claim up to (concurrency_cap - inflight) queued Tasks atomically.
 *
 * Two-phase:
 *   1) count inflight, compute slots, read a page of queued ids
 *   2) UPDATE ... WHERE id IN (...) AND status='queued' RETURNING *
 *      — WHERE guard is the race barrier; two workers can't both win.
 */
/**
 * A dependent Task is claimable when every dependency is "satisfied":
 *   - a standard dependency is satisfied once its PR is `merged`;
 *   - a triage `reproduce` dependency is satisfied once it is `resolved` AND its
 *     verdict says the bug reproduced. A negative verdict is NOT satisfaction —
 *     the reconciler abandons the dependent fix instead of unblocking it.
 * Pure and exported for testing.
 */
export function depsSatisfied(depIds: string[], deps: Task[]): boolean {
  return depIds.every((id) => {
    const dep = deps.find((d) => d.id === id);
    if (!dep) return false;
    if (dep.status === 'merged') return true;
    return dep.kind === 'reproduce' && dep.status === 'resolved' && dep.verdict?.reproduced === true;
  });
}

/**
 * For every currently-running mission that has a parent (an issue leaf
 * nested under a repo's container), computes how many of that container's
 * slots remain this tick. A leaf whose container is paused (Deactivate) or
 * doesn't exist gets zero slots — blocked, not unconstrained. Otherwise:
 * container concurrencyCap minus tasks already inflight across ALL its
 * children (siblings).
 *
 * Pure given its inputs — the caller (runDispatcher) queries the live
 * container rows and sibling-inflight counts once per tick and passes them
 * in. This is a per-tick snapshot, not perfectly atomic across siblings
 * claimed within the same tick — two siblings under a busy container could
 * each be handed the same remaining-slots ceiling and jointly claim
 * slightly over cap in one tick; the next tick's fresh snapshot
 * self-corrects. Exported for testing.
 */
export function computeContainerCaps(
  runningMissions: Mission[],
  containersById: Map<string, Mission>,
  siblingInflightByParentId: Map<string, number>,
): Map<string, number> {
  const caps = new Map<string, number>();
  for (const mission of runningMissions) {
    if (!mission.parentMissionId) continue;
    const container = containersById.get(mission.parentMissionId);
    if (!container || container.status !== 'running') {
      caps.set(mission.id, 0);
      continue;
    }
    const inflight = siblingInflightByParentId.get(mission.parentMissionId) ?? 0;
    caps.set(mission.id, Math.max(0, container.concurrencyCap - inflight));
  }
  return caps;
}

export async function claimNextBatch(mission: Mission, maxSlots?: number): Promise<Task[]> {
  const inflightRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.missionId, mission.id), inArray(tasks.status, INFLIGHT_STATUSES)));
  const inflight = Number(inflightRows[0]?.count ?? 0);
  let slots = Math.max(0, mission.concurrencyCap - inflight);
  if (maxSlots !== undefined) slots = Math.min(slots, maxSlots);
  if (slots === 0) return [];

  // Get all queued tasks for this mission
  const allQueued = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.missionId, mission.id), eq(tasks.status, 'queued')))
    .limit(slots * 3); // over-fetch to account for blocked tasks
  if (allQueued.length === 0) return [];

  // Filter out tasks whose dependencies aren't satisfied yet.
  const unblocked: string[] = [];
  for (const t of allQueued) {
    const depIds = (t.dependsOnIds as string[] | null) ?? [];
    if (depIds.length === 0) {
      unblocked.push(t.id);
      continue;
    }
    const deps = await db.select().from(tasks).where(inArray(tasks.id, depIds));
    if (depsSatisfied(depIds, deps)) {
      unblocked.push(t.id);
    }
  }

  const ids = unblocked.slice(0, slots);
  if (ids.length === 0) return [];
  const now = new Date();
  const claimed = await db
    .update(tasks)
    .set({ status: 'dispatching', dispatchedAt: now, updatedAt: now })
    .where(and(inArray(tasks.id, ids), eq(tasks.status, 'queued')))
    .returning();

  return claimed;
}

export async function dispatchOne(mission: Mission, task: Task): Promise<void> {
  const adapter = getAdapter(mission.backend);

  if (!mission.githubInstallationId) {
    throw new Error('mission is missing github_installation_id (repo clone credential)');
  }
  if (!env.GITHUB_APP_TOKEN) {
    throw new Error('GITHUB_APP_TOKEN not configured');
  }
  // github_vault_id is optional — agents without MCP tools don't need a vault.
  // When absent, createSession just passes vault_ids=[].

  // When a Skill is attached, prepend the skill's prompt template before the
  // mission goal so the agent has the playbook context, and narrow the toolset.
  // Triage Tasks pick their playbook by kind — the reproduce and fix stages need
  // different skills than the Mission's single skill_id can express.
  const skill =
    task.kind === 'reproduce'
      ? await getSkillBySlug('bug-reproduce')
      : task.kind === 'fix'
        ? await getSkillBySlug('bug-fix')
        : mission.skillId
          ? await getSkill(mission.skillId)
          : null;

  const vars: Record<string, unknown> = {
    repo: task.repo,
    base_branch: task.baseBranch,
    ...((task.promptVars as Record<string, unknown>) ?? {}),
  };

  // For a triage `fix` Task, thread the upstream reproduce verdict into the
  // prompt so the fixer starts from confirmed evidence (which versions are
  // affected, how it repros) instead of re-deriving it. Exposed as
  // {{repro_summary}}, {{repro_evidence}}, {{affected_versions}}.
  if (task.kind === 'fix') {
    const depIds = (task.dependsOnIds as string[] | null) ?? [];
    if (depIds.length > 0) {
      const deps = await db.select().from(tasks).where(inArray(tasks.id, depIds));
      const repro = deps.find((d) => d.kind === 'reproduce' && d.verdict);
      if (repro?.verdict) {
        vars.repro_summary = repro.verdict.summary;
        vars.repro_evidence = repro.verdict.evidence ?? '';
        vars.repro_branch = repro.verdict.branch ?? '';
        vars.affected_versions = repro.verdict.affectedVersions
          ? Object.entries(repro.verdict.affectedVersions)
              .map(([v, hit]) => `${v}: ${hit ? 'affected' : 'ok'}`)
              .join(', ')
          : '';
      }
    }
  }

  // LLM planner stores a custom per-task prompt in promptVars.custom_prompt.
  const taskGoal =
    ((task.promptVars as Record<string, unknown> | null)?.custom_prompt as string | undefined) ??
    mission.goal;

  // Surface relevant memories for this task's context
  const relevantMemories = await getRelevantMemories({
    repo: task.repo,
    backend: mission.backend,
  });
  const memoryBlock = formatMemoriesForPrompt(relevantMemories);

  // Fetch AGENTS.md / CLAUDE.md for this repo
  const agentsMd = await fetchAgentsMd(task.repo, mission.id);

  // Assemble prompt: Git setup → AGENTS.md → Skill → Goal → Memories
  const parts: string[] = [gitIdentitySetup()];
  if (agentsMd.content) {
    parts.push(agentsMd.content);
  }
  if (skill) {
    parts.push(renderPrompt(skill.promptTemplate, vars));
  }
  parts.push(renderPrompt(taskGoal, vars));
  if (memoryBlock) {
    parts.push(memoryBlock);
  }
  const prompt = parts.join('\n\n---\n\n');

  const { sessionId } = await adapter.createSession({
    agentId: mission.agentId,
    repoUrl: `https://github.com/${task.repo}`,
    repoCloneToken: env.GITHUB_APP_TOKEN,
    baseBranch: task.baseBranch,
    githubMcpVaultId: mission.githubVaultId,
    prompt,
  });

  const now = new Date();
  // Resolve acceptance criteria for the self-verify gate: prefer a per-task value
  // (e.g. from the LLM planner), else inherit the skill's loop policy. Progress
  // markers are intentionally NOT stamped here — the no-progress clock starts at
  // the first completed turn (poller), giving the first turn headroom (spec §1.1).
  await db
    .update(tasks)
    .set({
      status: 'running',
      sessionId,
      // Initially identical to sessionId. Backends that rotate their handle
      // (Gemini) update this on every turn; stable backends never change it.
      backendSessionRef: sessionId,
      updatedAt: now,
      ...(!task.acceptanceCriteria && skill?.loopPolicy?.acceptanceCriteria
        ? { acceptanceCriteria: skill.loopPolicy.acceptanceCriteria }
        : {}),
    })
    .where(and(eq(tasks.id, task.id), ne(tasks.status, 'queued')));

  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: mission.id,
    taskId: task.id,
    eventType: 'dispatcher.dispatched',
    payload: {
      sessionId,
      agentId: mission.agentId,
      repo: task.repo,
      baseBranch: task.baseBranch,
      ...(skill ? { skillSlug: skill.slug, skillVersion: skill.version } : {}),
      ...(agentsMd.file
        ? { agentsMdFile: agentsMd.file, agentsMdTruncated: agentsMd.truncated }
        : {}),
    },
    createdAt: now,
  });
}

async function markFailed(taskId: string, reason: string): Promise<void> {
  const now = new Date();
  await db
    .update(tasks)
    .set({ status: 'failed', lastError: reason, updatedAt: now, completedAt: now })
    .where(eq(tasks.id, taskId));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId:
      (await db.select({ id: tasks.missionId }).from(tasks).where(eq(tasks.id, taskId)))[0]?.id ??
      '',
    taskId,
    eventType: 'dispatcher.failed',
    payload: { reason },
    createdAt: now,
  });
}
