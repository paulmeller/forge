import { describe, expect, it } from 'vitest';

import { computeBudgetPct, TOKEN_PRICE_USD_PER_1M } from './budgets';

describe('computeBudgetPct', () => {
  it('returns zero when no budget is set', () => {
    const result = computeBudgetPct({ spentTokens: 500_000, budgetTokens: null, budgetUsd: null });
    expect(result.maxPct).toBe(0);
    expect(result.tokenPct).toBe(0);
    expect(result.usdPct).toBe(0);
  });

  it('computes token percentage correctly', () => {
    const result = computeBudgetPct({
      spentTokens: 800_000,
      budgetTokens: 1_000_000,
      budgetUsd: null,
    });
    expect(result.tokenPct).toBe(80);
    expect(result.maxPct).toBe(80);
  });

  it('computes USD percentage from token spend', () => {
    // 1M tokens at $5/1M = $5 spent, budget $10 → 50%
    const result = computeBudgetPct({
      spentTokens: 1_000_000,
      budgetTokens: null,
      budgetUsd: 10,
    });
    expect(result.spentUsd).toBe(5);
    expect(result.usdPct).toBe(50);
    expect(result.maxPct).toBe(50);
  });

  it('takes the max of token and USD percentage', () => {
    // Token: 900k / 1M = 90%. USD: 4.5 / 10 = 45%. Max = 90%.
    const result = computeBudgetPct({
      spentTokens: 900_000,
      budgetTokens: 1_000_000,
      budgetUsd: 10,
    });
    expect(result.tokenPct).toBe(90);
    expect(result.usdPct).toBe(45);
    expect(result.maxPct).toBe(90);
  });

  it('handles zero spend', () => {
    const result = computeBudgetPct({
      spentTokens: 0,
      budgetTokens: 1_000_000,
      budgetUsd: 10,
    });
    expect(result.maxPct).toBe(0);
    expect(result.spentUsd).toBe(0);
  });

  it('handles spend exceeding budget (>100%)', () => {
    const result = computeBudgetPct({
      spentTokens: 2_000_000,
      budgetTokens: 1_000_000,
      budgetUsd: null,
    });
    expect(result.tokenPct).toBe(200);
    expect(result.maxPct).toBe(200);
  });

  it('handles zero budget values (treated as no constraint)', () => {
    const result = computeBudgetPct({
      spentTokens: 500_000,
      budgetTokens: 0,
      budgetUsd: 0,
    });
    expect(result.tokenPct).toBe(0);
    expect(result.usdPct).toBe(0);
  });

  it('uses correct token price constant', () => {
    expect(TOKEN_PRICE_USD_PER_1M).toBe(5);
    const result = computeBudgetPct({
      spentTokens: 2_000_000,
      budgetTokens: null,
      budgetUsd: 5,
    });
    // 2M tokens * $5/1M = $10 spent, budget $5 → 200%
    expect(result.spentUsd).toBe(10);
    expect(result.usdPct).toBe(200);
  });
});
