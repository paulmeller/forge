import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import {
  ledgerEvents,
  missions,
  tasks,
  type EscalationReason,
  type HaltReason,
  type LoopPolicy,
  type TaskStatus,
} from '@forge/db';

import { Octokit } from '@octokit/rest';

import { getAdapter } from './adapters';
import { checkForgeBranch } from './completion';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { verifyCancelled } from './cancel-verify';
import { getSkill } from './skill-loader';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
};

export type GuardrailsResult = {
  tasksChecked: number;
  halted: number;
  byReason: Partial<Record<HaltReason, number>>;
};

/**
 * Guardrails only evaluate Tasks where new *agent* spend accrues. A Task parked
 * in a gate state (`awaiting_ci`/`awaiting_verify`/`ready_to_merge`/`needs_human`/...)
 * accrued its turns legitimately and burns only bounded gate-validator tokens —
 * halting it there would wrongly fail a Task sitting correctly in a
 * review/CI queue (spec §1).
 */
export const AGENT_ACTIVE_STATUSES: TaskStatus[] = [
  'dispatching',
  'running',
  'turn_ended',
];

export type Limits = { maxTurns: number; maxTokens: number; noProgressTokens: number };

/**
 * Effective per-task limits: Mission override → skill `loopPolicy` → env default.
 * A `maxTokens` of 0 means unbounded. Pure — exported for testing.
 */
export function resolveLimits(opts: {
  mission: {
    taskMaxTurns: number | null;
    taskMaxTokens: number | null;
    noProgressTokens: number | null;
  };
  policy: LoopPolicy | null;
  env: { TASK_MAX_TURNS: number; TASK_MAX_TOKENS: number; TASK_NO_PROGRESS_TOKENS: number };
}): Limits {
  const pick = (m: number | null, p: number | undefined, e: number): number => m ?? p ?? e;
  return {
    maxTurns: pick(opts.mission.taskMaxTurns, opts.policy?.maxTurns, opts.env.TASK_MAX_TURNS),
    maxTokens: pick(opts.mission.taskMaxTokens, opts.policy?.maxTokens, opts.env.TASK_MAX_TOKENS),
    noProgressTokens: pick(
      opts.mission.noProgressTokens,
      opts.policy?.noProgressTokens,
      opts.env.TASK_NO_PROGRESS_TOKENS,
    ),
  };
}

/**
 * First breached limit, in priority order: turn cap → token cap → no-progress.
 * A limit of 0 is "unbounded" and never breaches. Pure — exported for testing.
 */
export function checkBreach(
  task: { turnCount: number; costTokens: number; costTokensAtProgress: number },
  limits: Limits,
): HaltReason | null {
  if (limits.maxTurns > 0 && task.turnCount >= limits.maxTurns) return 'max_turns';
  if (limits.maxTokens > 0 && task.costTokens >= limits.maxTokens) return 'task_token_cap';
  if (
    limits.noProgressTokens > 0 &&
    task.costTokens - task.costTokensAtProgress >= limits.noProgressTokens
  ) {
    return 'no_progress';
  }
  return null;
}

function haltMessage(reason: HaltReason, limits: Limits): string {
  switch (reason) {
    case 'max_turns':
      return `halted: turn cap reached (${limits.maxTurns} turns)`;
    case 'task_token_cap':
      return `halted: per-task token cap reached (${limits.maxTokens} tokens)`;
    case 'no_progress':
      return `halted: no progress in ${limits.noProgressTokens} tokens`;
    default:
      return 'halted';
  }
}

/**
 * Halt agent-active Tasks that crossed a per-task hard stop (turn cap, token cap,
 * or no-progress). Runs right after the poller — which just wrote the freshest
 * `turnCount`/`costTokens` — so a runaway stops accruing work as early as
 * possible in the tick (spec §1).
 */
export async function runGuardrails(log: Logger): Promise<GuardrailsResult> {
  const active = await db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.status, AGENT_ACTIVE_STATUSES), isNotNull(tasks.sessionId)));

  let halted = 0;
  const byReason: Partial<Record<HaltReason, number>> = {};

  for (const task of active) {
    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, task.missionId))
      .limit(1);
    if (!mission) continue;

    let policy: LoopPolicy | null = null;
    if (mission.skillId) {
      const skill = await getSkill(mission.skillId);
      policy = skill?.loopPolicy ?? null;
    }

    const limits = resolveLimits({ mission, policy, env });
    const reason = checkBreach(task, limits);
    if (!reason) continue;

    // The no-progress guard measures tokens burned since the last progress
    // marker, and markers are only stamped on the first completed turn and the
    // first PR (poller.progressMarkers). Everything between those two points —
    // implementing, and running a suite the agent is correctly told to run — is
    // indistinguishable from spinning. Observed live (#57): an agent's last act
    // was "run existing tests to confirm baseline passes" and it was halted for
    // it.
    //
    // Commits on the branch Forge assigned are the evidence the marker was
    // missing. Ask the remote before halting — the same rule that governs
    // abandoning (#70) and reclaiming (#62): work that exists outranks an
    // inference that it doesn't. Only a CHANGED head SHA counts, so an agent
    // that pushed once and then genuinely spun still halts; the reprieve is
    // bounded by real output, not by time.
    if (reason === 'no_progress' && (await grantedProgressReprieve(task, log))) {
      continue;
    }

    // Best-effort cancel — a failure here must NOT block the status change.
    if (task.sessionId) {
      let cancelled = false;
      let cancelError: string | undefined;
      try {
        const adapter = getAdapter(mission.backend);
        await adapter.cancelSession(task.sessionId, task.backendSessionRef);
        cancelled = await verifyCancelled(adapter, task.sessionId, task.backendSessionRef);
      } catch (err) {
        cancelError = err instanceof Error ? err.message : String(err);
      }
      if (!cancelled) {
        // Single report for both "cancel threw" and "cancel didn't verify" —
        // don't also warn from the catch above, or one event logs twice.
        log.error({ taskId: task.id, reason, err: cancelError }, 'guardrails:cancel_unverified');
        // The status-change below must happen regardless of whether this insert
        // succeeds, so failures here are swallowed (and merely warned about).
        try {
          await db.insert(ledgerEvents).values({
            id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
            missionId: mission.id,
            taskId: task.id,
            eventType: 'guardrails.cancel_unverified',
            payload: {
              sessionId: task.sessionId,
              backendSessionRef: task.backendSessionRef,
              reason,
              err: cancelError,
            },
          });
        } catch (insertErr) {
          log.warn(
            {
              taskId: task.id,
              err: insertErr instanceof Error ? insertErr.message : String(insertErr),
            },
            'guardrails:cancel_unverified_ledger_failed',
          );
        }
      }
    }

    // A halt of a task that produced no branch/PR is the same stalled-branchless
    // outcome #51's continuation escalates to a human — so surface it in the
    // review queue as needs_human rather than dropping it to `failed` where it
    // has no Approve/Dismiss and no escalation copy. Two exceptions keep their
    // `failed` status: a task that DID open a PR (the halt is a runaway on real
    // output, not a stall), and a task something depends on — needs_human is not
    // a dependency-failed status, so escalating a depended-upon task would leave
    // its queued dependent waiting forever and wedge the mission. Those stay
    // failed so the reconciler's cascade sweep fires.
    let hasDependents = false;
    if (!task.prUrl) {
      const family = await db
        .select({ deps: tasks.dependsOnIds })
        .from(tasks)
        .where(eq(tasks.missionId, task.missionId));
      hasDependents = family.some((t) => ((t.deps as string[] | null) ?? []).includes(task.id));
    }
    const escalate = !task.prUrl && !hasDependents;

    const now = new Date();
    // Guarded on the observed status so a concurrent transition can't be clobbered.
    const [updated] = await db
      .update(tasks)
      .set({
        status: escalate ? 'needs_human' : 'failed',
        escalationReason: escalate ? ('stalled_no_branch' as EscalationReason) : null,
        // The halt cause is recorded either way, so a human (or the ledger)
        // still sees WHY it stalled.
        haltReason: reason,
        lastError: haltMessage(reason, limits),
        updatedAt: now,
        completedAt: now,
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
      .returning();
    if (!updated) continue; // lost the race; fine

    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'task.halted',
      payload: {
        reason,
        turnCount: task.turnCount,
        costTokens: task.costTokens,
        costTokensAtProgress: task.costTokensAtProgress,
        limits,
      },
      createdAt: now,
    });
    halted += 1;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    log.info({ taskId: task.id, reason }, 'guardrails:halted');
  }

  return { tasksChecked: active.length, halted, byReason };
}

/**
 * Did this Task push new commits since we last credited it with progress?
 *
 * Returns true when the no-progress halt should be skipped: the branch Forge
 * assigned carries commits whose head differs from the head recorded at the
 * last reprieve. The progress marker is re-stamped so the Task gets a fresh
 * budget from here, and the new head is recorded so the *next* breach only
 * relents if the agent has pushed again.
 *
 * Conservative on every uncertainty. No branch, no head SHA reported, or a
 * GitHub call that fails — all fall through to the halt. A guard that cannot
 * confirm progress must not invent it, or a genuinely runaway Task would be
 * granted an unbounded reprieve by a rate-limited API.
 */
async function grantedProgressReprieve(
  task: { id: string; missionId: string; repo: string; baseBranch: string; costTokens: number },
  log: Logger,
): Promise<boolean> {
  const [owner, repo] = task.repo.split('/');
  if (!owner || !repo) return false;

  let state: Awaited<ReturnType<typeof checkForgeBranch>>;
  try {
    state = await checkForgeBranch(new Octokit({ auth: env.GITHUB_APP_TOKEN }), {
      owner,
      repo,
      baseBranch: task.baseBranch || 'main',
      taskId: task.id,
    });
  } catch (err) {
    log.warn(
      { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
      'guardrails:progress_check_failed',
    );
    return false;
  }

  if (!state.present || !state.headSha) return false;

  const [seen] = await db
    .select({ payload: ledgerEvents.payload })
    .from(ledgerEvents)
    .where(
      and(eq(ledgerEvents.taskId, task.id), eq(ledgerEvents.eventType, 'task.progress_advanced')),
    )
    .orderBy(desc(ledgerEvents.createdAt))
    .limit(1);
  const lastHead = (seen?.payload as { headSha?: string } | null)?.headSha ?? null;
  if (lastHead === state.headSha) return false; // pushed once, spinning since

  const now = new Date();
  await db
    .update(tasks)
    .set({ costTokensAtProgress: task.costTokens, lastProgressAt: now, updatedAt: now })
    .where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'task.progress_advanced',
    payload: { headSha: state.headSha, aheadBy: state.aheadBy, costTokens: task.costTokens },
    createdAt: now,
  });
  log.info({ taskId: task.id, headSha: state.headSha }, 'guardrails:progress_reprieve');
  return true;
}
