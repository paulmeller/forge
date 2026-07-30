import { describe, expect, it, vi } from 'vitest';

import { checkForgeBranch } from './completion';

// Completion is a fact Forge checks, not a flag it infers: does the branch
// Forge named exist on the remote with commits on it? Asking GitHub directly
// is what lets this work from any task state, including a task a guardrail
// already halted.
function ghWith(compare: unknown, throws = false) {
  return {
    repos: {
      compareCommits: vi.fn(async () => {
        if (throws) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: compare };
      }),
    },
  };
}

const OPTS = { owner: 'acme', repo: 'api', baseBranch: 'main', taskId: 'tsk_1' };

describe('checkForgeBranch', () => {
  it('reports the branch present with its commit count when it is ahead of base', async () => {
    const gh = ghWith({ ahead_by: 2, files: [{ filename: 'a.ts' }, { filename: 'b.ts' }] });
    expect(await checkForgeBranch(gh as never, OPTS)).toEqual({
      present: true,
      aheadBy: 2,
      filesChanged: 2,
      additions: 0,
      deletions: 0,
      headSha: null,
    });
  });

  it('totals added and deleted lines across the changed files', async () => {
    // #75: diffAdditions used to be populated with a files count on one path
    // and a commit count on the other, so a 1842-line PR recorded as "8".
    // Blast radius is a real signal (cost reporting, and risk-proportional
    // gating later) and needs real line counts.
    const gh = ghWith({
      ahead_by: 1,
      files: [
        { filename: 'a.ts', additions: 1800, deletions: 80 },
        { filename: 'b.ts', additions: 42, deletions: 4 },
      ],
    });
    expect(await checkForgeBranch(gh as never, OPTS)).toMatchObject({
      filesChanged: 2,
      additions: 1842,
      deletions: 84,
    });
  });

  it('reports the head SHA so callers can tell new commits from a stale branch', async () => {
    // The no-progress guard (#57) needs to distinguish "the agent just pushed
    // more work" from "the agent pushed once and has been spinning since".
    // Only a changing head SHA answers that.
    const gh = ghWith({
      ahead_by: 2,
      files: [],
      commits: [{ sha: 'aaa111' }, { sha: 'bbb222' }],
    });
    const state = await checkForgeBranch(gh as never, OPTS);
    expect(state).toMatchObject({ present: true, headSha: 'bbb222' });
  });

  it('compares the Forge-named branch, not anything the agent chose', async () => {
    const gh = ghWith({ ahead_by: 1, files: [] });
    await checkForgeBranch(gh as never, OPTS);
    expect(gh.repos.compareCommits).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'main', head: 'forge/tsk_1' }),
    );
  });

  it('reports absent when the branch exists but has no commits on it', async () => {
    // A salvage push with nothing committed creates an empty branch. That is
    // not work, and must not open a pull request.
    const gh = ghWith({ ahead_by: 0, files: [] });
    expect(await checkForgeBranch(gh as never, OPTS)).toEqual({ present: false });
  });

  it('reports absent when the branch does not exist (compare 404s)', async () => {
    const gh = ghWith(null, true);
    expect(await checkForgeBranch(gh as never, OPTS)).toEqual({ present: false });
  });

  it('propagates a non-404 failure rather than calling it absent', async () => {
    // "Could not tell" is not "no work". Callers act on absence — a salvage
    // push, or declining to reclaim pushed work — so a GitHub outage reported
    // as absent would make Forge act on a wrong answer.
    const gh = {
      repos: {
        compareCommits: vi.fn(async () => {
          throw Object.assign(new Error('Server Error'), { status: 500 });
        }),
      },
    };
    await expect(checkForgeBranch(gh as never, OPTS)).rejects.toThrow('Server Error');
  });
});
