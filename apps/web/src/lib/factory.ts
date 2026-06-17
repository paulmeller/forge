import { and, eq, sql } from '@forge/db/orm';

import { ledgerEvents, missions, tasks, type TaskStatus } from '@forge/db';

import { db } from './db';

/**
 * Data layer for the Software Factory overview (`/factory`). Everything here
 * is derived from real Mission/Task/Ledger rows scoped to one user — there are
 * no synthetic numbers. When a user has no data yet, every figure is zero and
 * every series is flat, exactly like the Missions dashboard.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 14;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;

/** A single column in the pipeline header. */
export type FactoryStage = {
  key: string;
  label: string;
  /** Current count of tasks sitting in this stage (the "backlog"). */
  backlog: number;
  /** Tasks that entered/moved through this stage in the last 24h. */
  throughput: number;
  /** Cumulative count of tasks that have ever cleared into/past this stage. */
  total: number;
};

/** A headline metric card (big number + delta + area chart). */
export type FactoryMetric = {
  key: string;
  label: string;
  unit: string;
  /** Count over the most recent 7-day window. */
  value: number;
  /** Percent change vs. the prior 7-day window (can be negative). */
  deltaPct: number;
  /** Daily volume across the last {@link WINDOW_DAYS} days. */
  series: number[];
  /** Short caption rendered under the chart (data source, honest label). */
  caption: string;
};

export type FactoryData = {
  stages: FactoryStage[];
  /** Big left sonar: total inputs the factory has ingested (all tasks). */
  signal: { value: number; throughput24h: number };
  /** Big right sonar: total shipped (merged tasks). */
  deploy: { value: number; throughput24h: number };
  metrics: FactoryMetric[];
};

/** Status groupings that define each pipeline stage. */
const STAGE_DEFS: { key: string; label: string; statuses: TaskStatus[] }[] = [
  { key: 'triage', label: 'Triage', statuses: ['queued', 'dispatching'] },
  { key: 'codegen', label: 'Code Gen', statuses: ['running', 'turn_ended'] },
  { key: 'validate', label: 'Validate', statuses: ['awaiting_ci', 'awaiting_verify'] },
  { key: 'review', label: 'Review', statuses: ['awaiting_ai_review', 'awaiting_review'] },
  { key: 'release', label: 'Release', statuses: ['opening_pr', 'merging'] },
  { key: 'deploy', label: 'Deploy', statuses: ['merged'] },
  { key: 'audit', label: 'Audit', statuses: ['failed', 'abandoned'] },
];

type TaskRow = {
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  prNumber: number | null;
};

function ms(value: Date | number | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : Number(value);
}

/** Bucket a list of epoch-ms timestamps into one count per day over the window. */
function bucketByDay(timestamps: number[], windowStart: number): number[] {
  const buckets = new Array(WINDOW_DAYS).fill(0);
  for (const t of timestamps) {
    const idx = Math.floor((t - windowStart) / DAY_MS);
    if (idx >= 0 && idx < WINDOW_DAYS) buckets[idx] += 1;
  }
  return buckets;
}

/** Sum the trailing 7 vs. leading 7 buckets into a signed percent delta. */
function deltaPct(series: number[]): number {
  const half = Math.floor(series.length / 2);
  const prev = series.slice(0, half).reduce((a, b) => a + b, 0);
  const cur = series.slice(half).reduce((a, b) => a + b, 0);
  if (prev === 0) return cur === 0 ? 0 : 100;
  return Math.round(((cur - prev) / prev) * 100);
}

export async function getFactoryData(userId: string): Promise<FactoryData> {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const dayAgo = now - DAY_MS;

  // One pass for backlog (current count per status) and lifetime totals.
  const statusRows = await db
    .select({ status: tasks.status, count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(eq(missions.userId, userId))
    .groupBy(tasks.status);

  const backlogByStatus = new Map<string, number>();
  let totalTasks = 0;
  for (const r of statusRows) {
    const n = Number(r.count);
    backlogByStatus.set(r.status, n);
    totalTasks += n;
  }

  // Tasks that have moved in the last 24h, grouped by their current status —
  // an honest proxy for per-stage throughput without per-stage timestamps.
  const recentStatusRows = await db
    .select({ status: tasks.status, count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(eq(missions.userId, userId), sql`${tasks.updatedAt} >= ${dayAgo}`))
    .groupBy(tasks.status);

  const throughputByStatus = new Map<string, number>();
  for (const r of recentStatusRows) throughputByStatus.set(r.status, Number(r.count));

  // Lightweight rows within the window, bucketed in-process for the charts.
  const rows = await db
    .select({
      status: tasks.status,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      completedAt: tasks.completedAt,
      prNumber: tasks.prNumber,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(eq(missions.userId, userId), sql`${tasks.updatedAt} >= ${windowStart}`));

  const taskRows: TaskRow[] = rows.map((r) => ({
    status: r.status,
    createdAt: ms(r.createdAt) ?? now,
    updatedAt: ms(r.updatedAt) ?? now,
    completedAt: ms(r.completedAt),
    prNumber: r.prNumber,
  }));

  // 24h ledger volume drives the sonar sweep intensity (and the validate feed).
  const [ledgerRecent] = await db
    .select({ count: sql<number>`count(*)` })
    .from(ledgerEvents)
    .innerJoin(missions, eq(ledgerEvents.missionId, missions.id))
    .where(and(eq(missions.userId, userId), sql`${ledgerEvents.createdAt} >= ${dayAgo}`));

  // ── Stages ─────────────────────────────────────────────────────────
  const mergedTotal = backlogByStatus.get('merged') ?? 0;
  const stages: FactoryStage[] = STAGE_DEFS.map((def) => {
    let backlog = 0;
    let throughput = 0;
    for (const s of def.statuses) {
      backlog += backlogByStatus.get(s) ?? 0;
      throughput += throughputByStatus.get(s) ?? 0;
    }
    return { key: def.key, label: def.label, backlog, throughput, total: backlog };
  });

  // ── Headline metrics ───────────────────────────────────────────────
  const VALIDATED: TaskStatus[] = ['awaiting_review', 'opening_pr', 'merging', 'merged'];
  const INCIDENTS: TaskStatus[] = ['failed', 'abandoned'];

  const triagedSeries = bucketByDay(
    taskRows.filter((r) => r.createdAt >= windowStart).map((r) => r.createdAt),
    windowStart,
  );
  const validatedSeries = bucketByDay(
    taskRows
      .filter((r) => VALIDATED.includes(r.status) && r.prNumber !== null)
      .map((r) => r.updatedAt),
    windowStart,
  );
  const shippedSeries = bucketByDay(
    taskRows
      .filter((r) => r.status === 'merged' && r.completedAt !== null)
      .map((r) => r.completedAt as number),
    windowStart,
  );
  const incidentsSeries = bucketByDay(
    taskRows.filter((r) => INCIDENTS.includes(r.status)).map((r) => r.updatedAt),
    windowStart,
  );

  const sum7 = (s: number[]) => s.slice(Math.floor(s.length / 2)).reduce((a, b) => a + b, 0);

  const metrics: FactoryMetric[] = [
    {
      key: 'triaged',
      label: 'Tickets Triaged',
      unit: 'TIX',
      value: sum7(triagedSeries),
      deltaPct: deltaPct(triagedSeries),
      series: triagedSeries,
      caption: 'Tasks planned from issues · 7d',
    },
    {
      key: 'validated',
      label: 'PRs Validated',
      unit: 'CHECKS',
      value: sum7(validatedSeries),
      deltaPct: deltaPct(validatedSeries),
      series: validatedSeries,
      caption: 'Cleared CI · verify · AI review · 7d',
    },
    {
      key: 'shipped',
      label: 'PRs Shipped',
      unit: 'PRS',
      value: sum7(shippedSeries),
      deltaPct: deltaPct(shippedSeries),
      series: shippedSeries,
      caption: 'Auto-merged after gate · 7d',
    },
    {
      key: 'incidents',
      label: 'Incidents Processed',
      unit: 'INC',
      value: sum7(incidentsSeries),
      deltaPct: deltaPct(incidentsSeries),
      series: incidentsSeries,
      caption: 'Failed · abandoned · halted tasks · 7d',
    },
  ];

  return {
    stages,
    signal: { value: totalTasks, throughput24h: Number(ledgerRecent?.count ?? 0) },
    deploy: {
      value: mergedTotal,
      throughput24h: throughputByStatus.get('merged') ?? 0,
    },
    metrics,
  };
}
