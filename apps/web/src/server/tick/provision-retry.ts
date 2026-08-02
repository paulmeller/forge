import { randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { ledgerEvents, tasks, type Task } from '@forge/db';

import { db } from '@/lib/db';

type Logger = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };

/**
 * A provisioning failure is a session that died before the agent ever took a
 * turn — Docker VM disk exhaustion during harness bootstrap, an OOM-kill from
 * concurrent sandbox setup, a failed clone. It costs nothing (no model turn
 * ever ran) and is almost always transient, which makes it categorically
 * different from an agent that ran and failed. Today both are treated the
 * same — permanent `failed`/`abandoned`, cascade-failing the dependent Task
 * with it (DEPENDENCY_FAILED_STATUSES) — even though the agent was never
 * given a chance (#92). Matched on error text, the only signal available:
 * the engine's own `session.error` names the cause (managed-agents.ts's
 * `sessionFailureReason`) but not a structured category. Deliberately broad
 * — a false positive here just costs one bounded, free retry; a false
 * negative abandons real work outright.
 */
const PRE_AGENT_FAILURE_RE =
  /\b(bootstrap|clone|provisioning|ENOSPC|no space left|out of memory|OOM|SIGKILL|exit code 137)\b/i;

export function isPreAgentFailure(message: string | null | undefined, tokens: number): boolean {
  if (tokens > 0) return false; // any spend means the agent ran — this is not a provisioning failure
  if (!message) return false;
  return PRE_AGENT_FAILURE_RE.test(message);
}

/** Bounded so a persistently broken host still gives up, not just a noisy blip. */
export const PROVISION_RETRY_MAX = 3;
/** Doubles per attempt: 60s, 120s, 240s. */
export const PROVISION_RETRY_BASE_MS = 60_000;

export type ProvisionRetryDecision = 'retry' | 'wait' | 'exhausted';

/**
 * Doubling backoff for provisioning retries — same shape as ci-retry.ts's
 * decideCiRetry. `attempt` is how many provisioning retries this Task has
 * already spent (0 on its first-ever provisioning failure).
 */
export function decideProvisionRetry(opts: {
  attempt: number;
  lastAttemptAt: Date | null;
  now: Date;
  baseDelayMs?: number;
  maxAttempts?: number;
}): ProvisionRetryDecision {
  const maxAttempts = opts.maxAttempts ?? PROVISION_RETRY_MAX;
  if (opts.attempt >= maxAttempts) return 'exhausted';
  if (!opts.lastAttemptAt) return 'retry'; // never retried before — nothing to wait on
  const baseDelayMs = opts.baseDelayMs ?? PROVISION_RETRY_BASE_MS;
  const delay = baseDelayMs * 2 ** (opts.attempt - 1);
  const elapsed = opts.now.getTime() - opts.lastAttemptAt.getTime();
  return elapsed >= delay ? 'retry' : 'wait';
}

/** The most recent `task.provision_retry` ledger event for a Task, if any. */
async function latestProvisionRetry(taskId: string): Promise<{ attempt: number; at: Date } | null> {
  const [row] = await db
    .select({ payload: ledgerEvents.payload, createdAt: ledgerEvents.createdAt })
    .from(ledgerEvents)
    .where(and(eq(ledgerEvents.taskId, taskId), eq(ledgerEvents.eventType, 'task.provision_retry')))
    .orderBy(desc(ledgerEvents.createdAt))
    .limit(1);
  if (!row) return null;
  const attempt = (row.payload as { attempt?: number } | null)?.attempt ?? 0;
  return { attempt, at: row.createdAt as Date };
}

/**
 * Whether a queued Task with provisioning-retry history should sit out this
 * tick rather than be redispatched — the doubling-delay half of #92's fix.
 * Called from the dispatch loop right after a Task is claimed, before a real
 * createSession call is spent on a host that may still be unhealthy.
 */
export async function shouldWaitForProvisionBackoff(taskId: string, now: Date): Promise<boolean> {
  const last = await latestProvisionRetry(taskId);
  if (!last) return false;
  return decideProvisionRetry({ attempt: last.attempt, lastAttemptAt: last.at, now }) === 'wait';
}

/**
 * Decide the fate of a Task whose session died — called from both the
 * dispatcher (createSession threw before the first turn) and the poller
 * (session.status_terminated / session.error arrived with zero tokens
 * spent). A provisioning failure is requeued with bounded, doubling backoff;
 * anything else (or an exhausted provisioning failure) fails permanently
 * with the last error, exactly as before #92.
 */
export async function requeueOrAbandon(task: Task, message: string, log: Logger): Promise<void> {
  const now = new Date();
  const last = await latestProvisionRetry(task.id);
  const attempt = last?.attempt ?? 0;
  const decision = decideProvisionRetry({ attempt, lastAttemptAt: last?.at ?? null, now });

  if (decision !== 'exhausted') {
    const nextAttempt = attempt + 1;
    await db
      .update(tasks)
      .set({
        status: 'queued',
        sessionId: null,
        backendSessionRef: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id));
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'task.provision_retry',
      payload: { attempt: nextAttempt, reason: message },
      createdAt: now,
    });
    log.info({ taskId: task.id, attempt: nextAttempt }, 'provision_retry:requeued');
    return;
  }

  await db
    .update(tasks)
    .set({ status: 'failed', lastError: message, updatedAt: now, completedAt: now })
    .where(eq(tasks.id, task.id));
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId: task.missionId,
    taskId: task.id,
    eventType: 'task.provision_exhausted',
    payload: { attempts: attempt, reason: message },
    createdAt: now,
  });
  log.info({ taskId: task.id, attempts: attempt }, 'provision_retry:exhausted');
}
