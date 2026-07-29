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
