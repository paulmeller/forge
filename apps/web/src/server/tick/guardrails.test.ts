import { describe, expect, it } from 'vitest';

import { checkBreach, resolveLimits, type Limits } from './guardrails';

const ENV = { TASK_MAX_TURNS: 30, TASK_MAX_TOKENS: 0, TASK_NO_PROGRESS_TOKENS: 200_000 };

describe('resolveLimits — precedence (mission → skill → env)', () => {
  const noMissionOverride = { taskMaxTurns: null, taskMaxTokens: null, noProgressTokens: null };

  it('falls back to env when nothing is set', () => {
    expect(resolveLimits({ mission: noMissionOverride, policy: null, env: ENV })).toEqual({
      maxTurns: 30,
      maxTokens: 0,
      noProgressTokens: 200_000,
    });
  });

  it('skill policy overrides env', () => {
    const r = resolveLimits({
      mission: noMissionOverride,
      policy: { maxTurns: 12, noProgressTokens: 120_000 },
      env: ENV,
    });
    expect(r.maxTurns).toBe(12);
    expect(r.noProgressTokens).toBe(120_000);
    expect(r.maxTokens).toBe(0); // unset in policy → env
  });

  it('mission override beats skill policy and env', () => {
    const r = resolveLimits({
      mission: { taskMaxTurns: 5, taskMaxTokens: 500_000, noProgressTokens: 50_000 },
      policy: { maxTurns: 12, maxTokens: 999, noProgressTokens: 120_000 },
      env: ENV,
    });
    expect(r).toEqual({ maxTurns: 5, maxTokens: 500_000, noProgressTokens: 50_000 });
  });
});

describe('checkBreach — boundaries and priority', () => {
  const limits: Limits = { maxTurns: 30, maxTokens: 500_000, noProgressTokens: 200_000 };
  const base = { turnCount: 0, costTokens: 0, costTokensAtProgress: 0 };

  it('returns null when under every limit', () => {
    expect(
      checkBreach({ turnCount: 29, costTokens: 100, costTokensAtProgress: 0 }, limits),
    ).toBeNull();
  });

  it('turn cap fires exactly at >= maxTurns', () => {
    expect(checkBreach({ ...base, turnCount: 29 }, limits)).toBeNull();
    expect(checkBreach({ ...base, turnCount: 30 }, limits)).toBe('max_turns');
  });

  it('token cap fires exactly at >= maxTokens', () => {
    // Hold no-progress harmless by keeping the progress baseline close to spend.
    expect(
      checkBreach({ turnCount: 0, costTokens: 499_999, costTokensAtProgress: 450_000 }, limits),
    ).toBeNull();
    expect(
      checkBreach({ turnCount: 0, costTokens: 500_000, costTokensAtProgress: 450_000 }, limits),
    ).toBe('task_token_cap');
  });

  it('no-progress fires on tokens since last progress', () => {
    expect(
      checkBreach({ ...base, costTokens: 199_999, costTokensAtProgress: 0 }, limits),
    ).toBeNull();
    expect(checkBreach({ ...base, costTokens: 200_000, costTokensAtProgress: 0 }, limits)).toBe(
      'no_progress',
    );
    // baseline offset is respected
    expect(
      checkBreach({ ...base, costTokens: 350_000, costTokensAtProgress: 200_000 }, limits),
    ).toBeNull();
  });

  it('priority: turn cap wins when multiple limits breach', () => {
    expect(
      checkBreach({ turnCount: 30, costTokens: 600_000, costTokensAtProgress: 0 }, limits),
    ).toBe('max_turns');
  });

  it('priority: token cap beats no-progress', () => {
    expect(
      checkBreach({ turnCount: 0, costTokens: 600_000, costTokensAtProgress: 0 }, limits),
    ).toBe('task_token_cap');
  });

  it('a 0 (unbounded) limit never breaches', () => {
    const unbounded: Limits = { maxTurns: 0, maxTokens: 0, noProgressTokens: 0 };
    expect(
      checkBreach({ turnCount: 9999, costTokens: 9_999_999, costTokensAtProgress: 0 }, unbounded),
    ).toBeNull();
  });
});
