import { describe, expect, it } from 'vitest';

import { computeRepoBudget } from './repo-budget';

type Row = Parameters<typeof computeRepoBudget>[0][number];

function container(over: Partial<Row> = {}): Row {
  return { spentUsd: 0, budgetUsd: null, issueRef: null, parentMissionId: null, ...over };
}
function leaf(over: Partial<Row> = {}): Row {
  return { spentUsd: 0, budgetUsd: null, issueRef: 'acme/api#1', parentMissionId: 'msn_c', ...over };
}

describe('computeRepoBudget', () => {
  it('returns zeros and no cap for an empty repo', () => {
    expect(computeRepoBudget([])).toEqual({ spentUsd: 0, capUsd: null, pct: null });
  });

  it('sums spend across container and leaves, cap from the container', () => {
    const rows = [
      container({ budgetUsd: 100 }),
      leaf({ spentUsd: 12.5 }),
      leaf({ spentUsd: 7.5, issueRef: 'acme/api#2' }),
    ];
    expect(computeRepoBudget(rows)).toEqual({ spentUsd: 20, capUsd: 100, pct: 20 });
  });

  it('reports no cap (null pct) when the container has no budget', () => {
    const rows = [container(), leaf({ spentUsd: 3 })];
    expect(computeRepoBudget(rows)).toEqual({ spentUsd: 3, capUsd: null, pct: null });
  });

  it('pct can exceed 100 when over budget', () => {
    const rows = [container({ budgetUsd: 10 }), leaf({ spentUsd: 25 })];
    expect(computeRepoBudget(rows)).toEqual({ spentUsd: 25, capUsd: 10, pct: 250 });
  });

  it('ignores a leaf-level budgetUsd — only the container defines the cap', () => {
    const rows = [container({ budgetUsd: 50 }), leaf({ spentUsd: 5, budgetUsd: 999 })];
    expect(computeRepoBudget(rows)).toEqual({ spentUsd: 5, capUsd: 50, pct: 10 });
  });
});
