import { describe, expect, it } from 'vitest';

import { forgeBranchName } from './branch-name';

// Forge assigns this name and opens the PR from it. It is the fact that
// replaces every inference Forge used to make about an agent's output, so it
// must be derivable from the task id alone — no stored column, nothing to
// drift.
describe('forgeBranchName', () => {
  it('is derived from the task id', () => {
    expect(forgeBranchName('tsk_abc123')).toBe('forge/tsk_abc123');
  });

  it('is stable — the same task always maps to the same branch', () => {
    expect(forgeBranchName('tsk_abc123')).toBe(forgeBranchName('tsk_abc123'));
  });

  it('gives different tasks different branches', () => {
    expect(forgeBranchName('tsk_a')).not.toBe(forgeBranchName('tsk_b'));
  });
});
