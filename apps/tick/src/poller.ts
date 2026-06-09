import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import { ledgerEvents, missions, tasks, type Task, type TaskStatus } from '@forge/db';

import { getAdapter } from './adapters';
import type { BackendAdapter, BackendEvent } from './adapters/types';
import { db } from './db';
import { transition, type StateTransition } from './state';

/**
 * Tools we'll auto-confirm when an MCP server's permission policy is `ask`.
 * Anything else stays paused — the operator can intervene manually.
 *
 * For Phase 1 the only critical one is the GitHub MCP create_pull_request
 * call; we let the agent open PRs without a per-Task review gate. Any
 * destructive action (merge, push --force, branch delete) is NOT in this
 * list and would block.
 */
export const AUTO_ALLOW_TOOLS = new Set<string>([
  'create_pull_request',
  'create_pull_request_review_comment',
  'add_issue_comment',
  'create_or_update_file',
]);

const POLLABLE_STATUSES: TaskStatus[] = ['dispatching', 'running', 'turn_ended', 'opening_pr'];

export type PollResult = {
  tasksPolled: number;
  eventsIngested: number;
  transitions: number;
  errors: number;
};

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
};

export async function runPoller(log: Logger): Promise<PollResult> {
  const active = await db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.status, POLLABLE_STATUSES), isNotNull(tasks.sessionId)));

  let eventsIngested = 0;
  let transitions = 0;
  let errors = 0;

  for (const task of active) {
    try {
      const result = await pollOne(task);
      eventsIngested += result.eventsIngested;
      transitions += result.transitions;
    } catch (err) {
      errors += 1;
      log.warn(
        { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
        'poller:task_failed',
      );
    }
  }

  return { tasksPolled: active.length, eventsIngested, transitions, errors };
}

async function pollOne(task: Task): Promise<{ eventsIngested: number; transitions: number }> {
  if (!task.sessionId) return { eventsIngested: 0, transitions: 0 };

  const [mission] = await db
    .select({ id: missions.id, backend: missions.backend })
    .from(missions)
    .where(eq(missions.id, task.missionId))
    .limit(1);
  if (!mission) return { eventsIngested: 0, transitions: 0 };

  const adapter = getAdapter(mission.backend);

  // Cursor: the most-recent source_event_id we've already recorded for this task.
  const [latestLedger] = await db
    .select({ sourceEventId: ledgerEvents.sourceEventId })
    .from(ledgerEvents)
    .where(and(eq(ledgerEvents.taskId, task.id), isNotNull(ledgerEvents.sourceEventId)))
    .orderBy(desc(ledgerEvents.createdAt))
    .limit(1);

  const { events } = await adapter.listEvents({
    sessionId: task.sessionId,
    afterEventId: latestLedger?.sourceEventId ?? undefined,
  });

  if (events.length === 0) return { eventsIngested: 0, transitions: 0 };

  // Append only the events we haven't ingested before — ledger idempotency
  // gates the reduction so a re-poll never re-counts turns or re-stamps cost.
  const newEvents: BackendEvent[] = [];
  for (const ev of events) {
    const inserted = await appendLedger(task, ev);
    if (inserted === 0) continue; // already ingested by a previous tick
    newEvents.push(ev);
  }
  const ingested = newEvents.length;

  const { pendingDelta, turnsCompleted, transitionCount } = reduceEvents(task.status, newEvents);

  if (hasAnyDelta(pendingDelta) || turnsCompleted > 0) {
    await applyDelta(task, pendingDelta, turnsCompleted);
  }

  // After ingesting events, look at the latest session_idle event. If it's
  // requires_action and points at a tool_use we auto-allow, confirm it.
  await maybeAutoConfirm(task, adapter, events);

  return { eventsIngested: ingested, transitions: transitionCount };
}

/**
 * If the most recent idle event is `requires_action` and the blocking
 * tool_use (mcp or built-in) is in our auto-allow list, send a
 * user.tool_confirmation event so the session can resume.
 */
async function maybeAutoConfirm(
  task: Task,
  adapter: BackendAdapter,
  events: BackendEvent[],
): Promise<void> {
  if (!task.sessionId) return;

  // Walk events newest-first. Find the latest session.status_idle.
  let pendingEventIds: string[] | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.type === 'session.status_idle') {
      const stop = (ev.raw as { stop_reason?: { type?: string; event_ids?: string[] } })
        .stop_reason;
      if (stop?.type === 'requires_action' && Array.isArray(stop.event_ids)) {
        pendingEventIds = stop.event_ids;
      }
      break;
    }
    if (ev.type === 'session.status_running' || ev.type === 'session.status_terminated') {
      // a later running/terminated supersedes any earlier idle
      return;
    }
  }
  if (!pendingEventIds || pendingEventIds.length === 0) return;

  // For each pending tool use, decide allow / leave-blocking. We only confirm
  // tools we recognise; anything else is left for human intervention.
  const eventsById = new Map(events.map((e) => [e.id, e]));
  for (const id of pendingEventIds) {
    const tu = eventsById.get(id);
    if (!tu) continue;
    if (tu.type !== 'agent.mcp_tool_use' && tu.type !== 'agent.tool_use') continue;
    const name = (tu.raw as { name?: string }).name;
    if (!name || !AUTO_ALLOW_TOOLS.has(name)) {
      // Block intentionally — operator decides.
      continue;
    }
    await adapter.confirmToolUse(task.sessionId, id, { result: 'allow' });
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: 'forge.tool_confirmed',
      payload: { toolUseId: id, toolName: name, result: 'allow' },
      createdAt: new Date(),
    });
  }
}

async function appendLedger(task: Task, ev: BackendEvent): Promise<number> {
  const result = await db
    .insert(ledgerEvents)
    .values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: task.missionId,
      taskId: task.id,
      eventType: ev.type,
      payload: ev.raw,
      sourceEventId: ev.id,
      createdAt: ev.processedAt ?? new Date(),
    })
    .onConflictDoNothing({ target: [ledgerEvents.taskId, ledgerEvents.sourceEventId] })
    .returning({ id: ledgerEvents.id });
  return result.length;
}

/**
 * Reduce a batch of new backend events to a single merged delta, the number of
 * completed turns, and the count of distinct status changes. Pure — exported
 * for testing. Turns are counted PER-EVENT (not from the merged delta), because
 * `mergeDelta` collapses several `running ↔ turn_ended` cycles in one poll
 * window down to a single status; counting on the merged delta would undercount
 * the fast-spinning runaway the turn cap exists to catch (spec §1.1).
 */
export function reduceEvents(
  startStatus: TaskStatus,
  events: BackendEvent[],
): { pendingDelta: StateTransition; turnsCompleted: number; transitionCount: number } {
  let currentStatus = startStatus;
  let pendingDelta: StateTransition = {};
  let turnsCompleted = 0;
  let transitionCount = 0;

  for (const ev of events) {
    const delta = transition(currentStatus, ev);
    if (!delta) continue;
    pendingDelta = mergeDelta(pendingDelta, delta);
    if (delta.turnCompleted) turnsCompleted += 1;
    if (delta.status && delta.status !== currentStatus) {
      currentStatus = delta.status;
      transitionCount += 1;
    }
  }

  return { pendingDelta, turnsCompleted, transitionCount };
}

/**
 * Decide whether this poll constitutes forward progress for the no-progress
 * guard, and the markers to stamp. Progress is a code push, not a pipeline hop:
 * the clock starts at the FIRST completed turn (headroom for the first turn) and
 * re-stamps on the FIRST PR. Gate round-trips never reset it. Pure — exported
 * for testing (spec §1.1).
 */
export function progressMarkers(opts: {
  lastProgressAt: Date | null;
  prevPrUrl: string | null;
  newPrUrl: string | null | undefined;
  turnsCompleted: number;
  newCostTokens: number;
  now: Date;
}): { lastProgressAt: Date; costTokensAtProgress: number } | null {
  const firstTurn = opts.turnsCompleted > 0 && opts.lastProgressAt === null;
  const firstPr = opts.newPrUrl != null && !opts.prevPrUrl;
  if (firstTurn || firstPr) {
    return { lastProgressAt: opts.now, costTokensAtProgress: opts.newCostTokens };
  }
  return null;
}

export function mergeDelta(a: StateTransition, b: StateTransition): StateTransition {
  return {
    status: b.status ?? a.status,
    prUrl: b.prUrl ?? a.prUrl,
    prNumber: b.prNumber ?? a.prNumber,
    costTokensDelta: (a.costTokensDelta ?? 0) + (b.costTokensDelta ?? 0),
    lastError: b.lastError ?? a.lastError,
    completed: b.completed ?? a.completed,
  };
}

export function hasAnyDelta(d: StateTransition): boolean {
  return (
    d.status !== undefined ||
    d.prUrl !== undefined ||
    d.prNumber !== undefined ||
    (d.costTokensDelta ?? 0) > 0 ||
    d.lastError !== undefined ||
    d.completed === true
  );
}

async function applyDelta(task: Task, d: StateTransition, turnsCompleted = 0): Promise<void> {
  const now = new Date();
  const patch: Record<string, unknown> = { updatedAt: now };
  if (d.status) patch.status = d.status;
  if (d.prUrl !== undefined) patch.prUrl = d.prUrl;
  if (d.prNumber !== undefined) patch.prNumber = d.prNumber;
  if (d.lastError !== undefined) patch.lastError = d.lastError;
  if (d.completed) patch.completedAt = now;

  // Read-then-write is fine here: the poller only writes to each task from
  // one tick at a time (tick is serial), so no concurrent-update race.
  const newCostTokens =
    d.costTokensDelta && d.costTokensDelta > 0
      ? task.costTokens + d.costTokensDelta
      : task.costTokens;
  if (newCostTokens !== task.costTokens) patch.costTokens = newCostTokens;

  if (turnsCompleted > 0) patch.turnCount = task.turnCount + turnsCompleted;

  const progress = progressMarkers({
    lastProgressAt: task.lastProgressAt,
    prevPrUrl: task.prUrl,
    newPrUrl: d.prUrl,
    turnsCompleted,
    newCostTokens,
    now,
  });
  if (progress) {
    patch.lastProgressAt = progress.lastProgressAt;
    patch.costTokensAtProgress = progress.costTokensAtProgress;
  }

  await db.update(tasks).set(patch).where(eq(tasks.id, task.id));
}
