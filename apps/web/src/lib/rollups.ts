import { and, inArray, sql } from 'drizzle-orm';

import { ledgerEvents, tasks, type TaskStatus } from '@forge/db';

import { db } from './db';
import type { MissionRollup, TaskRollup } from '@/components/progress-pill';

const TOKEN_PRICE_USD_PER_1M = 5; // rough blended for budget display only

const IN_FLIGHT: TaskStatus[] = [
  'dispatching',
  'running',
  'turn_ended',
  'opening_pr',
  'awaiting_ci',
  'merging',
];

type RawCounts = {
  total: number;
  inFlight: number;
  awaitingReview: number;
  merged: number;
  abandoned: number;
  failed: number;
  spentTokens: number;
};

/** Aggregate counts and spend per Mission. One round-trip total. */
export async function rollupMissions(missionIds: string[]): Promise<Map<string, MissionRollup>> {
  if (missionIds.length === 0) return new Map();

  const rows = await db
    .select({
      missionId: tasks.missionId,
      status: tasks.status,
      count: sql<number>`count(*)`,
      tokens: sql<number>`coalesce(sum(${tasks.costTokens}), 0)`,
    })
    .from(tasks)
    .where(inArray(tasks.missionId, missionIds))
    .groupBy(tasks.missionId, tasks.status);

  const lastEventRows = await db
    .select({
      missionId: ledgerEvents.missionId,
      lastAt: sql<number>`max(${ledgerEvents.createdAt})`,
    })
    .from(ledgerEvents)
    .where(inArray(ledgerEvents.missionId, missionIds))
    .groupBy(ledgerEvents.missionId);

  const lastByMission = new Map<string, Date>();
  for (const r of lastEventRows) {
    if (r.lastAt) lastByMission.set(r.missionId, new Date(Number(r.lastAt)));
  }

  const counts = new Map<string, RawCounts>();
  const empty = (): RawCounts => ({
    total: 0,
    inFlight: 0,
    awaitingReview: 0,
    merged: 0,
    abandoned: 0,
    failed: 0,
    spentTokens: 0,
  });

  for (const row of rows) {
    const c = counts.get(row.missionId) ?? empty();
    const n = Number(row.count);
    c.total += n;
    c.spentTokens += Number(row.tokens);
    if (IN_FLIGHT.includes(row.status as TaskStatus)) c.inFlight += n;
    else if (row.status === 'awaiting_review') c.awaitingReview += n;
    else if (row.status === 'merged') c.merged += n;
    else if (row.status === 'abandoned') c.abandoned += n;
    else if (row.status === 'failed') c.failed += n;
    counts.set(row.missionId, c);
  }

  const rollups = new Map<string, MissionRollup>();
  for (const id of missionIds) {
    const c = counts.get(id) ?? empty();
    rollups.set(id, {
      ...c,
      spentUsd: (c.spentTokens / 1_000_000) * TOKEN_PRICE_USD_PER_1M,
      lastEventAt: lastByMission.get(id) ?? null,
    });
  }
  return rollups;
}

/** Per-Task tool-call counts (and the cost we already store on the task row). */
export async function rollupTasks(taskIds: string[]): Promise<Map<string, TaskRollup>> {
  if (taskIds.length === 0) return new Map();

  const taskRows = await db
    .select({
      id: tasks.id,
      dispatchedAt: tasks.dispatchedAt,
      completedAt: tasks.completedAt,
      costTokens: tasks.costTokens,
    })
    .from(tasks)
    .where(inArray(tasks.id, taskIds));

  const eventRows = await db
    .select({
      taskId: ledgerEvents.taskId,
      eventType: ledgerEvents.eventType,
      count: sql<number>`count(*)`,
    })
    .from(ledgerEvents)
    .where(
      and(
        inArray(ledgerEvents.taskId, taskIds),
        inArray(ledgerEvents.eventType, [
          'agent.tool_use',
          'agent.tool_result',
          'agent.mcp_tool_use',
          'agent.mcp_tool_result',
        ]),
      ),
    )
    .groupBy(ledgerEvents.taskId, ledgerEvents.eventType);

  const callsByTask = new Map<string, { uses: number; results: number }>();
  for (const r of eventRows) {
    if (!r.taskId) continue;
    const e = callsByTask.get(r.taskId) ?? { uses: 0, results: 0 };
    const n = Number(r.count);
    if (r.eventType === 'agent.tool_use' || r.eventType === 'agent.mcp_tool_use') e.uses += n;
    else e.results += n;
    callsByTask.set(r.taskId, e);
  }

  const rollups = new Map<string, TaskRollup>();
  for (const t of taskRows) {
    const calls = callsByTask.get(t.id) ?? { uses: 0, results: 0 };
    rollups.set(t.id, {
      toolCalls: calls.uses,
      toolResults: calls.results,
      costTokens: t.costTokens,
      startedAt: t.dispatchedAt,
      endedAt: t.completedAt,
    });
  }
  return rollups;
}

// Used by callers to render a budget gauge: convert tokens to USD.
export function tokensToUsd(tokens: number): number {
  return (tokens / 1_000_000) * TOKEN_PRICE_USD_PER_1M;
}

const SPARKLINE_BUCKETS = 30;
const SPARKLINE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Returns N event-volume buckets per Mission across the last 24h. Used as
 * the sparkline series in the Missions list — shows activity bursts at a
 * glance without us having to derive task-state-over-time (expensive).
 */
export async function sparklinesForMissions(
  missionIds: string[],
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (missionIds.length === 0) return result;

  const now = Date.now();
  const start = now - SPARKLINE_WINDOW_MS;
  const bucketMs = SPARKLINE_WINDOW_MS / SPARKLINE_BUCKETS;

  const rows = await db
    .select({
      missionId: ledgerEvents.missionId,
      createdAt: ledgerEvents.createdAt,
    })
    .from(ledgerEvents)
    .where(
      and(
        inArray(ledgerEvents.missionId, missionIds),
        sql`${ledgerEvents.createdAt} >= ${start}`,
      ),
    );

  for (const id of missionIds) {
    result.set(id, new Array(SPARKLINE_BUCKETS).fill(0));
  }

  for (const r of rows) {
    const t = r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt);
    const idx = Math.min(SPARKLINE_BUCKETS - 1, Math.floor((t - start) / bucketMs));
    if (idx < 0) continue;
    const arr = result.get(r.missionId);
    if (arr) arr[idx] = (arr[idx] ?? 0) + 1;
  }
  return result;
}
