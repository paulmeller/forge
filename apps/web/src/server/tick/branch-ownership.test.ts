import { describe, expect, it } from 'vitest';

import { branchIsTaskOwned, newestCommitDate } from './branch-ownership';

// The reconciler discovers branches by listing the repo, because the agent
// chooses its own branch name (Claude Code pushes `claude/<slug>`), so Forge
// cannot match on a name it dictated. That discovery must NOT adopt a branch
// this task did not produce: a task for issue #47 whose agent pushed nothing
// opened a PR from a six-week-old dashboard branch that merely happened to be
// ahead of main. These tests pin the provenance gate that prevents it.

describe('branchIsTaskOwned', () => {
  const dispatched = new Date('2026-07-29T02:40:00Z');

  it('trusts a branch whose name Forge told the task to use', () => {
    // A name-owned branch needs no time check — the name is the provenance.
    expect(branchIsTaskOwned('forge/tsk_abc', ['forge/tsk_abc'], null, null)).toBe(true);
  });

  it('adopts a discovered branch pushed after the task was dispatched', () => {
    const pushed = new Date('2026-07-29T02:45:00Z');
    expect(branchIsTaskOwned('claude/fix-xy', ['forge/tsk_abc'], pushed, dispatched)).toBe(true);
  });

  it('rejects a discovered branch whose head predates the task — the observed incident', () => {
    const stale = new Date('2026-06-17T21:13:00Z');
    expect(branchIsTaskOwned('claude/feature-request-8mt6am', ['forge/tsk_abc'], stale, dispatched)).toBe(false);
  });

  it('rejects a discovered branch when the task has no dispatch time to compare against', () => {
    // No provenance signal at all → fail closed rather than adopt a stranger.
    const pushed = new Date('2026-07-29T02:45:00Z');
    expect(branchIsTaskOwned('claude/fix-xy', ['forge/tsk_abc'], pushed, null)).toBe(false);
  });

  it('rejects a discovered branch when its head commit date is unknown', () => {
    expect(branchIsTaskOwned('claude/fix-xy', ['forge/tsk_abc'], null, dispatched)).toBe(false);
  });
});

describe('newestCommitDate', () => {
  it('returns the last commit in a base..head comparison (compare lists oldest first)', () => {
    const commits = [
      { commit: { committer: { date: '2026-07-29T02:41:00Z' } } },
      { commit: { committer: { date: '2026-07-29T02:45:00Z' } } },
    ];
    expect(newestCommitDate(commits)?.toISOString()).toBe('2026-07-29T02:45:00.000Z');
  });

  it('falls back to the author date when committer date is absent', () => {
    const commits = [{ commit: { author: { date: '2026-07-29T02:45:00Z' } } }];
    expect(newestCommitDate(commits)?.toISOString()).toBe('2026-07-29T02:45:00.000Z');
  });

  it('returns null for an empty comparison', () => {
    expect(newestCommitDate([])).toBeNull();
  });
});
