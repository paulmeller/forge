/**
 * What a Mission actually cost.
 *
 * A software factory's unit economic is cost per *merged* change, and until now
 * Forge could not answer "what did that fix cost?" without querying the database
 * by hand. Every input already exists — `tasks.costTokens`, the `agent.tool_use`
 * ledger events, the diff counters — but nothing brought them together.
 *
 * Measured baselines that motivated this (see
 * docs/superpowers/specs/2026-07-31-factory-economics-design.md): three live
 * dogfood runs cost 8.6M, 14.5M and 12.0M tokens for small fixes, and two of the
 * three delivered nothing until a human recovered the work by hand. Each phase
 * of that plan is judged by the delta in this report, so the aggregation is kept
 * pure and separately testable from the query that feeds it.
 */

/** One task's raw counters, as stored. Nulls are "never recorded", not zero. */
export type TaskCostRow = {
  taskId: string;
  kind: string | null;
  status: string;
  costTokens: number | null;
  diffAdditions: number | null;
  diffDeletions: number | null;
  toolCalls: number;
  dispatchedAt: Date | null;
  completedAt: Date | null;
};

export type TaskCost = {
  taskId: string;
  kind: string | null;
  status: string;
  tokens: number;
  toolCalls: number;
  diffLines: number;
  /** Null while the task is still running — not zero, which would read as instant. */
  wallClockMs: number | null;
};

export type MissionCost = {
  tasks: TaskCost[];
  totalTokens: number;
  totalToolCalls: number;
  mergedTasks: number;
  /**
   * Total tokens divided by tasks that actually merged — the factory metric.
   *
   * Deliberately priced against merged tasks rather than all tasks: a correct
   * fix that was abandoned still cost real tokens and delivered nothing, and
   * averaging it across attempts would hide exactly the failure this number
   * exists to expose. Null when nothing merged — 0 would read as "free" and
   * Infinity breaks formatting.
   */
  tokensPerMergedTask: number | null;
};

export function buildMissionCost(rows: TaskCostRow[]): MissionCost {
  const tasks: TaskCost[] = rows.map((r) => ({
    taskId: r.taskId,
    kind: r.kind,
    status: r.status,
    tokens: r.costTokens ?? 0,
    toolCalls: r.toolCalls,
    diffLines: (r.diffAdditions ?? 0) + (r.diffDeletions ?? 0),
    wallClockMs:
      r.dispatchedAt && r.completedAt
        ? r.completedAt.getTime() - r.dispatchedAt.getTime()
        : null,
  }));

  const totalTokens = tasks.reduce((n, t) => n + t.tokens, 0);
  const totalToolCalls = tasks.reduce((n, t) => n + t.toolCalls, 0);
  const mergedTasks = tasks.filter((t) => t.status === 'merged').length;

  return {
    tasks,
    totalTokens,
    totalToolCalls,
    mergedTasks,
    tokensPerMergedTask: mergedTasks > 0 ? Math.round(totalTokens / mergedTasks) : null,
  };
}

/**
 * Load one Mission's cost from the database.
 *
 * Tool calls are counted from the Ledger rather than a denormalised column, for
 * the same reason the continuation and CI-retry budgets are: the Ledger is the
 * record, so it cannot drift from one. Kept separate from `buildMissionCost` so
 * the aggregation stays unit-testable without a database.
 */
export async function loadMissionCost(missionId: string): Promise<MissionCost> {
  const { db } = await import('./db');
  const { tasks, ledgerEvents } = await import('@forge/db');
  const { eq, and, sql } = await import('drizzle-orm');

  const taskRows = await db.select().from(tasks).where(eq(tasks.missionId, missionId));

  const toolCounts = await db
    .select({ taskId: ledgerEvents.taskId, n: sql<number>`count(*)` })
    .from(ledgerEvents)
    .where(
      and(eq(ledgerEvents.missionId, missionId), eq(ledgerEvents.eventType, 'agent.tool_use')),
    )
    .groupBy(ledgerEvents.taskId);

  const byTask = new Map(toolCounts.map((r) => [r.taskId, Number(r.n)]));

  return buildMissionCost(
    taskRows.map((t) => ({
      taskId: t.id,
      kind: t.kind,
      status: t.status,
      costTokens: t.costTokens,
      diffAdditions: t.diffAdditions,
      diffDeletions: t.diffDeletions,
      toolCalls: byTask.get(t.id) ?? 0,
      dispatchedAt: t.dispatchedAt,
      completedAt: t.completedAt,
    })),
  );
}
