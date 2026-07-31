/**
 * The single token→dollar rate for budget and spend *display*.
 *
 * A rough blended figure, deliberately not per-model: it drives budget
 * percentages and the spend shown on the repo/mission pages, not billing.
 * It lived in three places (budgets.ts, rollups.ts, and — by omission — the
 * repo page, which read a denormalised column instead) and drifted into a
 * repo page that reported $0 while the same work showed real spend elsewhere.
 * One source now, so every surface agrees.
 */
export const TOKEN_PRICE_USD_PER_1M = 5;

/** Convert a token count to its display dollar cost at the blended rate. */
export function tokensToUsd(tokens: number): number {
  return (tokens / 1_000_000) * TOKEN_PRICE_USD_PER_1M;
}

/**
 * Per-tier rates, USD per million tokens.
 *
 * Anthropic bills four tiers at very different rates: a cache read is roughly a
 * tenth of fresh input, and a cache write is a premium paid once so later reads
 * are cheap. Forge previously summed all four and priced the total at the
 * blended input rate, which overstated a measured 141-call run by ~10x — 11.7M
 * of its "input" was cache reads whose raw share was about 2 tokens per call
 * (#76). Ratios matter more than absolute accuracy here: these drive budget
 * percentages and displayed spend, not billing.
 */
export const TOKEN_RATES_USD_PER_1M = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
} as const;

/** One model request's usage, tiers absent when the backend did not report them. */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/**
 * Total tokens consumed, every tier at face value.
 *
 * This is what budget ceilings count: a budget caps consumption, and weighting
 * the tiers would let a cache-heavy agent run far past a stated token cap.
 * Use `usdFromUsage` for anything expressed in money.
 */
export function billableTokens(u: TokenUsage): number {
  return (
    u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
  );
}

/** Dollar cost of one usage record, each tier at its own rate. */
export function usdFromUsage(u: TokenUsage): number {
  const r = TOKEN_RATES_USD_PER_1M;
  return (
    (u.inputTokens * r.input +
      u.outputTokens * r.output +
      (u.cacheReadTokens ?? 0) * r.cacheRead +
      (u.cacheWriteTokens ?? 0) * r.cacheWrite) /
    1_000_000
  );
}
