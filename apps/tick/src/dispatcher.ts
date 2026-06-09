import { randomUUID } from 'node:crypto';

import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type Mission, type Task, type TaskStatus } from '@forge/db';

import { getAdapter } from './adapters';
import { fetchAgentsMd } from './agents-md';
import { env } from './env';
import { db } from './db';
import { getRelevantMemories, formatMemoriesForPrompt } from './memory';
import { renderPrompt } from './prompt';
import { getSkill } from './skill-loader';

export const INFLIGHT_STATUSES: TaskStatus[] = [
  'dispatching',
  'running',
  'turn_ended',
  'opening_pr',
  'awaiting_ci',
  'awaiting_verify',
  'awaiting_ai_review',
  'awaiting_review',
  'merging',
];

export type DispatchResult = {
  missions: number;
  claimed: number;
  dispatched: number;
  failed: number;
};

export async function runDispatcher(log: {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}): Promise<DispatchResult> {
  const runningMissions = await db.select().from(missions).where(eq(missions.status, 'running'));

  let totalClaimed = 0;
  let totalDispatched = 0;
  let totalFailed = 0;

  for (const mission of runningMissions) {
    const claimed = await claimNextBatch(mission);
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
export async function claimNextBatch(mission: Mission): Promise<Task[]> {
  const inflightRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.missionId, mission.id), inArray(tasks.status, INFLIGHT_STATUSES)));
  const inflight = Number(inflightRows[0]?.count ?? 0);
  const slots = Math.max(0, mission.concurrencyCap - inflight);
  if (slots === 0) return [];

  // Get all queued tasks for this mission
  const allQueued = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.missionId, mission.id), eq(tasks.status, 'queued')))
    .limit(slots * 3); // over-fetch to account for blocked tasks
  if (allQueued.length === 0) return [];

  // Filter out tasks whose dependencies haven't merged yet
  const unblocked: string[] = [];
  for (const t of allQueued) {
    const depIds = (t.dependsOnIds as string[] | null) ?? [];
    if (depIds.length === 0) {
      unblocked.push(t.id);
      continue;
    }
    // Check if ALL dependencies are merged
    const [depCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(inArray(tasks.id, depIds), eq(tasks.status, 'merged')));
    if (Number(depCount?.count ?? 0) === depIds.length) {
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
    throw new Error('GITHUB_APP_TOKEN not configured on forge-tick');
  }
  // github_vault_id is optional — agents without MCP tools don't need a vault.
  // When absent, createSession just passes vault_ids=[].

  // When a Skill is attached, prepend the skill's prompt template before the
  // mission goal so the agent has the playbook context, and narrow the toolset.
  const skill = mission.skillId ? await getSkill(mission.skillId) : null;

  const vars = {
    repo: task.repo,
    base_branch: task.baseBranch,
    ...((task.promptVars as Record<string, unknown>) ?? {}),
  };

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

  // Assemble prompt: AGENTS.md → Skill → Goal → Memories
  const parts: string[] = [];
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
