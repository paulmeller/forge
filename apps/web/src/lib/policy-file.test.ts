import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, parsePolicyFile, policyFileTemplate } from './policy-file';

describe('parsePolicyFile', () => {
  it('parses a complete policy', () => {
    const res = parsePolicyFile(`
gates:
  ci: true
  selfVerify: false
  aiReview: true
autoMerge:
  enabled: true
  maxAdditions: 50
requirePlanApproval: false
budgets:
  taskTokens: 2000000
  taskTurns: 30
  noProgressTokens: 2000000
concurrencyCap: 3
`);
    expect(res).toEqual({
      ok: true,
      policy: {
        gates: { ci: true, selfVerify: false, aiReview: true },
        autoMerge: { enabled: true, maxAdditions: 50 },
        requirePlanApproval: false,
        budgets: { taskTokens: 2_000_000, taskTurns: 30, noProgressTokens: 2_000_000 },
        concurrencyCap: 3,
      },
    });
  });

  it('fills omitted sections from the safe defaults', () => {
    // A file that only pins one thing is valid; the rest takes the safe
    // default. This is NOT the database merge the spec forbids — it is
    // defaulting WITHIN the file, which keeps the file the whole policy.
    const res = parsePolicyFile('gates:\n  aiReview: false\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.policy.gates).toEqual({ ci: true, selfVerify: true, aiReview: false });
    expect(res.policy.autoMerge.enabled).toBe(false);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    // A typo must not read as "not configured". Silently ignoring
    // `autoMerge: enabld:` would leave auto-merge off while the operator
    // believes they enabled it — or worse, the reverse.
    const res = parsePolicyFile('autoMerg:\n  enabled: true\n');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/autoMerg/);
  });

  it('rejects a wrong type with a message naming the field', () => {
    const res = parsePolicyFile('gates:\n  ci: "yes"\n');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/gates\.ci/);
  });

  it('rejects malformed YAML without throwing', () => {
    const res = parsePolicyFile('gates:\n  ci: [unclosed\n');
    expect(res.ok).toBe(false);
  });

  it('treats an empty file as the safe defaults', () => {
    // An empty policy.yml is a deliberate "use defaults", not an error —
    // it is what the onboarding template degrades to if every line is
    // deleted, and defaults are safe (auto-merge off, all gates on).
    expect(parsePolicyFile('')).toEqual({ ok: true, policy: DEFAULT_POLICY });
  });

  it('defaults to auto-merge OFF and every gate ON', () => {
    expect(DEFAULT_POLICY.autoMerge.enabled).toBe(false);
    expect(DEFAULT_POLICY.gates).toEqual({ ci: true, selfVerify: true, aiReview: true });
  });
});

describe('policyFileTemplate', () => {
  it('round-trips through the parser', () => {
    // The file Forge proposes must be one Forge accepts. Without this the
    // onboarding PR can ship a file that blocks dispatch the moment it merges.
    const yaml = policyFileTemplate({ repo: 'acme/api', verifyCommand: 'pnpm test' });
    const res = parsePolicyFile(yaml);
    expect(res.ok).toBe(true);
  });

  it('proposes auto-merge off', () => {
    const yaml = policyFileTemplate({ repo: 'acme/api', verifyCommand: null });
    const res = parsePolicyFile(yaml);
    expect(res.ok && res.policy.autoMerge.enabled).toBe(false);
  });

  it('mentions the repo and the verify command it detected', () => {
    const yaml = policyFileTemplate({ repo: 'acme/api', verifyCommand: 'pnpm test' });
    expect(yaml).toContain('acme/api');
    expect(yaml).toContain('pnpm test');
  });
});
