import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNotNull } from 'drizzle-orm';

import {
  ledgerEvents,
  missions,
  tasks,
  type HaltReason,
  type LoopPolicy,
  type TaskStatus,
} from '@forge/db';

import { getAdapter } from './adapters';
import { db } from './db';
import { env } from './env';
import { getSkill } from './skill-loader';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type GuardrailsResult = {
  tasksChecked: number;
  halted: number;
  byReason: Partial<Record<HaltReason, number>>;
};

/**
 * Guardrails only evaluate Tasks where new *agent* spend accrues. A Task parked
 * in a gate state (`awaiting_ci`/`awaiting_verify`/`awaiting_review`/...) accrued
 * its turns legitimately and burns only bounded gate-validator tokens — halting
 * it there would wrongly fail a Task sitting correctly in a review/CI queue
 * (spec §1).
 */
export const AGENT_ACTIVE_STATUSES: TaskStatus[] = [
  'dispatching',
  'running',
  'turn_ended',
  'opening_pr',
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

    // Best-effort cancel — a failure here must NOT block the status change.
    if (task.sessionId) {
      try {
        await getAdapter(mission.backend).cancelSession(task.sessionId);
      } catch (err) {
        log.warn(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'guardrails:cancel_failed',
        );
      }
    }

    const now = new Date();
    // Guarded on the observed status so a concurrent transition can't be clobbered.
    const [updated] = await db
      .update(tasks)
      .set({
        status: 'failed',
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
