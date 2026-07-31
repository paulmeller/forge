import { describe, expect, it } from 'vitest';

import { billableTokens, tokensToUsd, usdFromUsage } from './token-pricing';

describe('cache-aware pricing', () => {
  // Measured live: a 141-call run reported 11.7M "input" of which the raw share
  // was ~2 tokens per call — the rest cache reads, which bill at ~10% of base.
  // Summing the tiers at face value overstated that run's cost by roughly 10x.
  it('prices cache reads far below fresh input', () => {
    const fresh = usdFromUsage({ inputTokens: 1_000_000, outputTokens: 0 });
    const cached = usdFromUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
    expect(cached).toBeLessThan(fresh / 5);
  });

  it('prices cache writes above fresh input', () => {
    // A cache write costs more than the same tokens sent uncached; it pays back
    // only on later reads. Pricing it at or below base would make caching look
    // free and hide a thrashing agent that rewrites the cache every turn.
    const fresh = usdFromUsage({ inputTokens: 1_000_000, outputTokens: 0 });
    const written = usdFromUsage({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 });
    expect(written).toBeGreaterThan(fresh);
  });

  it('prices output above fresh input', () => {
    expect(usdFromUsage({ inputTokens: 0, outputTokens: 1_000_000 })).toBeGreaterThan(
      usdFromUsage({ inputTokens: 1_000_000, outputTokens: 0 }),
    );
  });

  it('reprices the measured run to single-digit dollars, not ~$60', () => {
    // The real #41 shape: cache reads dominate, generation is tiny.
    const usd = usdFromUsage({ inputTokens: 300, outputTokens: 42_847, cacheReadTokens: 11_600_000, cacheWriteTokens: 124_785 });
    expect(usd).toBeGreaterThan(1);
    expect(usd).toBeLessThan(15);
    // The old flat-rate arithmetic on the same numbers:
    expect(tokensToUsd(11_725_085 + 42_847)).toBeGreaterThan(55);
  });

  it('billableTokens still totals every tier for budget ceilings', () => {
    // Budgets cap consumption, not spend — a tier-weighted count would let a
    // cache-heavy agent run far past a token ceiling.
    expect(billableTokens({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 })).toBe(100);
  });

  it('treats absent tiers as zero', () => {
    expect(billableTokens({ inputTokens: 5, outputTokens: 5 })).toBe(10);
    expect(usdFromUsage({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});
