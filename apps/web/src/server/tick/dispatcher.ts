import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import {
  githubInstallationRepos,
  ledgerEvents,
  missions,
  tasks,
  type Mission,
  type Task,
  type TaskStatus,
} from '@forge/db';

import { AdapterNotImplementedError, getAdapter, type BackendAdapter } from './adapters';
import { fetchAgentsMd } from './agents-md';
import { env } from '@/lib/env';
import { db } from '@/lib/db';
import { checkAgentInstructions } from './agent-contract';
import { getRelevantMemories, formatMemoriesForPrompt } from './memory';
import { renderOwnedVars, renderPrompt } from './prompt';
import { getSkill, getSkillBySlug } from './skill-loader';
import { forgeBranchName } from './branch-name';
import { requeueOrAbandon, shouldWaitForProvisionBackoff } from './provision-retry';

type Logger = { warn: (o: object, m?: string) => void };

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
  // Missions this tick whose CONTAINER cap (computeContainerCaps below)
  // computed zero remaining slots while queued work was waiting on them —
  // see runDispatcher's starvation check for why this needs its own signal.
  starved: number;
};

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
  let totalStarved = 0;

  for (const mission of runningMissions) {
    const maxSlots = containerCaps.get(mission.id);
    // Zero slots is ambiguous on its own: "nothing queued" and "the
    // container is full of zombie Tasks" both end in claimed.length === 0
    // with no way to tell them apart (#84 — a container full of
    // needs_human/ready_to_merge Tasks, all counted in-flight by
    // INFLIGHT_STATUSES, computed zero slots forever with no signal
    // anywhere). Only maxSlots — the CONTAINER cap — is checked here, not
    // the mission's own concurrencyCap: a mission simply busy at its own cap
    // is the ordinary, self-explanatory case this signal isn't for.
    if (maxSlots === 0 && (await hasQueuedWork(mission.id))) {
      totalStarved += 1;
      await recordStarvation(mission, maxSlots, log);
    }

    const claimed = await claimNextBatch(mission, maxSlots);
    totalClaimed += claimed.length;
    if (claimed.length === 0) continue;

    for (const task of claimed) {
      // A Task that already failed provisioning once sits out its doubling
      // backoff window rather than burning another createSession call on a
      // host that may still be unhealthy (#92) — revert the claim, don't
      // dispatch, and let a later tick pick it back up once the delay elapses.
      if (await shouldWaitForProvisionBackoff(task.id, new Date())) {
        await db
          .update(tasks)
          .set({ status: 'queued', updatedAt: new Date() })
          .where(eq(tasks.id, task.id));
        continue;
      }

      try {
        await dispatchOne(mission, task, log);
        totalDispatched += 1;
      } catch (err) {
        totalFailed += 1;
        const message = err instanceof Error ? err.message : String(err);
        log.error({ taskId: task.id, err: message }, 'dispatch:failed');
        await requeueOrAbandon(task, message, log);
      }
    }
  }

  return {
    missions: runningMissions.length,
    claimed: totalClaimed,
    dispatched: totalDispatched,
    failed: totalFailed,
    starved: totalStarved,
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

async function hasQueuedWork(missionId: string): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.missionId, missionId), eq(tasks.status, 'queued')));
  return Number(row?.count ?? 0) > 0;
}

/**
 * Ledger the starvation once per episode, not once per tick (#84). The tick
 * re-checks every 60s, and this condition can persist for hours until an
 * operator notices — logging it unconditionally would flood the mission's
 * ledger with an identical row every tick for as long as it lasts (the same
 * spam budgets.ts's hard-stop check avoids). A mission's most recent ledger
 * event already IS "what happened last", live and free of any extra state to
 * maintain: if it's already `dispatch.starved`, nothing has changed since we
 * said so, so stay quiet; anything else (a claim, a transition, a merge)
 * means this is worth saying again.
 */
async function recordStarvation(mission: Mission, maxSlots: number, log: Logger): Promise<void> {
  const [latest] = await db
    .select({ eventType: ledgerEvents.eventType })
    .from(ledgerEvents)
    .where(eq(ledgerEvents.missionId, mission.id))
    .orderBy(desc(ledgerEvents.createdAt))
    .limit(1);
  if (latest?.eventType === 'dispatch.starved') return;

  const now = new Date();
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: mission.id,
    eventType: 'dispatch.starved',
    payload: { reason: 'container_cap', maxSlots },
    createdAt: now,
  });
  log.warn({ missionId: mission.id, maxSlots }, 'dispatch:starved');
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

  // Filter out tasks whose dependencies aren't satisfied yet, and tasks whose
  // repo has not merged its onboarding policy file (#40). A single mission
  // can target more than one repo (a fleet/campaign mission's tasks aren't
  // all the same repo), so this is checked per task's own repo rather than
  // once for the mission — one queued task per line above.
  const onboardingCache = new Map<string, boolean>();
  const unblocked: string[] = [];
  for (const t of allQueued) {
    if (!(await repoIsOnboarded(t.repo, mission.githubInstallationId, onboardingCache))) continue;

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

/**
 * Consent before action (#40). A repo is not dispatchable until its operator
 * has merged the proposed `.forge/policy.yml`. This is the only gate: every
 * dispatch path reaches `claimNextBatch` above, so guarding here cannot be
 * bypassed by a caller that forgets to check.
 *
 * Scoped by `installationId` (the mission's `githubInstallationId`), not repo
 * alone: `github_installation_repos`' unique index is (installationId, repo),
 * so two different installations can each legitimately hold a row for the
 * identical repo string (see repo-policy.ts's `getRepoPolicy` doc comment for
 * the same rule). No row at all — including no known installation id — means
 * unaffected, not blocked: a repo connected before the gate shipped is
 * grandfathered active by the migration and must not be treated as pending.
 */
async function repoIsOnboarded(
  repo: string,
  installationId: string | null,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const cached = cache.get(repo);
  if (cached !== undefined) return cached;

  let active = true;
  if (installationId) {
    const [repoRow] = await db
      .select({ state: githubInstallationRepos.onboardingState })
      .from(githubInstallationRepos)
      .where(
        and(eq(githubInstallationRepos.repo, repo), eq(githubInstallationRepos.installationId, installationId)),
      )
      .limit(1);
    active = !repoRow || repoRow.state === 'active';
  }
  cache.set(repo, active);
  return active;
}

export async function dispatchOne(mission: Mission, task: Task, log?: Logger): Promise<void> {
  const adapter = getAdapter(mission.backend);

  if (!mission.githubInstallationId) {
    throw new Error('mission is missing github_installation_id (repo clone credential)');
  }
  if (!env.GITHUB_APP_TOKEN) {
    throw new Error('GITHUB_APP_TOKEN not configured');
  }
  // github_vault_id is optional — agents without MCP tools don't need a vault.
  // When absent, createSession just passes vault_ids=[].

  await checkAgentContract(adapter, mission, task, log);

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
    // The branch Forge will open the pull request from. Exposed so a goal
    // template can name it explicitly; AGENTS.md instructs the agent to push
    // here and not to open a PR itself (it cannot — the sandbox egress
    // allowlist omits api.github.com).
    forge_branch: forgeBranchName(task.id),
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

  // Assemble prompt: AGENTS.md → Skill → Goal → Memories. Git identity is no
  // longer prepended here: the sandbox provisions it deterministically (a
  // self-hosted Managed Agents sandbox is the operator's to configure, and it
  // now runs `git config` after cloning), so the agent no longer spends a turn
  // on git housekeeping or self-recovers from a failed first commit.
  const parts: string[] = [];
  if (agentsMd.content) {
    // AGENTS.md comes from the target repository, so only Forge's own
    // placeholders are substituted — see renderOwnedVars.
    parts.push(renderOwnedVars(agentsMd.content, vars, ['forge_branch']));
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

/**
 * #67: check the backend agent's own configured instructions against the
 * contract dispatch depends on (see agent-contract.ts) before handing it a
 * Task. A drift between AGENTS.md and the agent's own system prompt has
 * already discarded a completed fix once (#58/#66) with no signal until a
 * human happened to notice — this is the signal.
 *
 * Non-fatal by default: writes a `dispatch.contract_warning` ledger event so
 * a drifting agent is visible, but does not stop dispatch unless an operator
 * opts into AGENT_CONTRACT_BLOCK. A backend that can't report its agent's
 * instructions (AdapterNotImplementedError, or any other failure fetching
 * them) is "unknown", not a violation, and must never block dispatch on its
 * own account.
 */
async function checkAgentContract(
  adapter: BackendAdapter,
  mission: Mission,
  task: Task,
  log?: Logger,
): Promise<void> {
  let system: string | null;
  try {
    system = await adapter.getAgentInstructions(mission.agentId);
  } catch (err) {
    if (err instanceof AdapterNotImplementedError) return;
    log?.warn(
      { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
      'dispatch:agent_instructions_unavailable',
    );
    return;
  }

  const violations = checkAgentInstructions(system);
  if (violations.length === 0) return;

  log?.warn(
    { taskId: task.id, agentId: mission.agentId, violations },
    'dispatch:contract_warning',
  );
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: mission.id,
    taskId: task.id,
    eventType: 'dispatch.contract_warning',
    payload: { agentId: mission.agentId, violations },
    createdAt: new Date(),
  });

  if (env.AGENT_CONTRACT_BLOCK) {
    throw new Error(
      `agent ${mission.agentId} instructions violate the dispatch contract: ` +
        violations.map((v) => v.rule).join(', '),
    );
  }
}
