import { describe, expect, it } from 'vitest';

import { buildMissionCost, type TaskCostRow } from './cost-report';

function row(over: Partial<TaskCostRow> = {}): TaskCostRow {
  return {
    taskId: 'tsk_1',
    kind: 'fix',
    status: 'merged',
    costTokens: 1_000_000,
    diffAdditions: 40,
    diffDeletions: 5,
    toolCalls: 30,
    dispatchedAt: new Date('2026-07-30T10:00:00Z'),
    completedAt: new Date('2026-07-30T10:05:00Z'),
    ...over,
  };
}

describe('buildMissionCost', () => {
  it('totals tokens and tool calls across the mission', () => {
    const r = buildMissionCost([row(), row({ taskId: 'tsk_2', costTokens: 500_000, toolCalls: 12 })]);
    expect(r.totalTokens).toBe(1_500_000);
    expect(r.totalToolCalls).toBe(42);
  });

  it('reports diff size as added plus deleted lines', () => {
    const r = buildMissionCost([row({ diffAdditions: 1842, diffDeletions: 84 })]);
    expect(r.tasks[0]!.diffLines).toBe(1926);
  });

  it('computes wall-clock from dispatch to completion', () => {
    const r = buildMissionCost([row()]);
    expect(r.tasks[0]!.wallClockMs).toBe(5 * 60 * 1000);
  });

  it('leaves wall-clock null while a task is still running', () => {
    const r = buildMissionCost([row({ completedAt: null })]);
    expect(r.tasks[0]!.wallClockMs).toBeNull();
  });

  // The factory's unit economic (spec: 2026-07-31-factory-economics-design.md).
  // Only tasks that actually merged count as delivered output — a correct fix
  // that was abandoned cost real tokens and delivered nothing, and averaging it
  // away would hide exactly the failure this metric exists to expose.
  it('prices tokens against MERGED tasks only', () => {
    const r = buildMissionCost([
      row({ taskId: 'tsk_1', status: 'merged', costTokens: 2_000_000 }),
      row({ taskId: 'tsk_2', status: 'abandoned', costTokens: 12_000_000 }),
    ]);
    expect(r.mergedTasks).toBe(1);
    expect(r.tokensPerMergedTask).toBe(14_000_000);
  });

  it('reports tokens-per-merged-task as null when nothing merged, never zero or Infinity', () => {
    // A mission that burned 12M and merged nothing has no meaningful rate.
    // Returning 0 would read as "free"; Infinity breaks formatting.
    const r = buildMissionCost([row({ status: 'abandoned', costTokens: 12_000_000 })]);
    expect(r.tokensPerMergedTask).toBeNull();
    expect(r.totalTokens).toBe(12_000_000);
  });

  it('handles an empty mission without dividing by zero', () => {
    const r = buildMissionCost([]);
    expect(r).toMatchObject({ totalTokens: 0, totalToolCalls: 0, mergedTasks: 0, tokensPerMergedTask: null });
  });

  it('treats missing counters as zero rather than NaN', () => {
    const r = buildMissionCost([
      row({ costTokens: null, diffAdditions: null, diffDeletions: null, toolCalls: 0 }),
    ]);
    expect(r.totalTokens).toBe(0);
    expect(r.tasks[0]!.diffLines).toBe(0);
  });
});
