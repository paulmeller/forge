import { describe, expect, it } from 'vitest';

import { checkAgentInstructions } from './agent-contract';

describe('checkAgentInstructions', () => {
  it('returns no violations for null/undefined/empty instructions', () => {
    expect(checkAgentInstructions(null)).toEqual([]);
    expect(checkAgentInstructions(undefined)).toEqual([]);
    expect(checkAgentInstructions('')).toEqual([]);
  });

  it('returns no violations for instructions that align with the contract', () => {
    const system =
      'You are a coding agent. Commit your work as you go and push it to the branch ' +
      'you were given. Do not open a pull request yourself — the orchestrator opens it.';
    expect(checkAgentInstructions(system)).toEqual([]);
  });

  // #58/#66: the agent's own system prompt told it not to push a completed
  // fix, discarding real work. This is the exact class of drift the checker
  // exists to catch.
  it('flags an instruction to withhold or not push work', () => {
    const violations = checkAgentInstructions('Do not push your changes until a human reviews them.');
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: 'withholds_work' }),
    );
  });

  it('flags an instruction to withhold work on verification failure', () => {
    const violations = checkAgentInstructions(
      'If self-verification fails, withhold the fix and wait for further instructions.',
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: 'withholds_work' }),
    );
  });

  it('flags "never commit" the same way as "never push"', () => {
    const violations = checkAgentInstructions('Never commit code that has not been reviewed.');
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: 'withholds_work' }),
    );
  });

  // The #66 fix hand-edited an agent record carrying a fixed sandbox path —
  // the class of bug this rule exists to catch before it needs a human again.
  it('flags a hardcoded absolute repo path', () => {
    const violations = checkAgentInstructions('Always cd into /home/agent/workspace/repo first.');
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: 'hardcoded_path' }),
    );
  });

  it('flags a hardcoded /Users path the same way', () => {
    const violations = checkAgentInstructions('The repo lives at /Users/dev/project — start there.');
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: 'hardcoded_path' }),
    );
  });

  it('flags an instruction to open a pull request', () => {
    const violations = checkAgentInstructions('When you are done, open a pull request with your changes.');
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: 'opens_pr' }),
    );
  });

  it('flags an instruction to create a PR (short form)', () => {
    const violations = checkAgentInstructions('Create a PR once tests pass.');
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: 'opens_pr' }),
    );
  });

  it('flags an instruction to merge', () => {
    const violations = checkAgentInstructions('Merge the pull request as soon as CI is green.');
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: 'opens_pr' }),
    );
  });

  // Compliant instructions frequently state the rule as a negative ("do not
  // open a pull request") — that phrasing must not itself trip the same
  // denylist entry it's agreeing with.
  it('does not flag a negated instruction not to open a pull request', () => {
    const violations = checkAgentInstructions("Don't open a pull request — the orchestrator does that.");
    expect(violations.filter((v) => v.rule === 'opens_pr')).toEqual([]);
  });

  it('does not flag a negated instruction not to merge', () => {
    const violations = checkAgentInstructions('You must not merge the branch yourself.');
    expect(violations.filter((v) => v.rule === 'opens_pr')).toEqual([]);
  });

  it('reports multiple distinct violations at once', () => {
    const system =
      'Do not push until told to. Work inside /root/workspace/repo. ' +
      'When finished, open a pull request.';
    const violations = checkAgentInstructions(system);
    const rules = violations.map((v) => v.rule);
    expect(rules).toContain('withholds_work');
    expect(rules).toContain('hardcoded_path');
    expect(rules).toContain('opens_pr');
  });

  it('every violation carries a human-readable detail', () => {
    const violations = checkAgentInstructions('Never push your work.');
    for (const v of violations) {
      expect(typeof v.detail).toBe('string');
      expect(v.detail.length).toBeGreaterThan(0);
    }
  });
});
