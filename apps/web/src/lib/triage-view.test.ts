import { describe, expect, it } from 'vitest';

import type { Task } from '@forge/db';

import { groupTasksByIssue, headlineFor } from './triage-view';

const task = (over: Partial<Task>): Task =>
  ({
    id: 'tsk_x',
    missionId: 'mis_1',
    repo: 'vercel/ai',
    baseBranch: 'main',
    promptVars: null,
    issueRef: 'vercel/ai#12389',
    kind: 'reproduce',
    verdict: null,
    dependsOnIds: null,
    status: 'queued',
    sessionId: null,
    prUrl: null,
    prNumber: null,
    diffAdditions: null,
    diffDeletions: null,
    filesChanged: null,
    retryCount: 0,
    aiReviewRetryCount: 0,
    turnCount: 0,
    lastProgressAt: null,
    costTokensAtProgress: 0,
    verifyRetryCount: 0,
    lastVerifiedSha: null,
    haltReason: null,
    acceptanceCriteria: null,
    lastError: null,
    costUsd: 0,
    costTokens: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    dispatchedAt: null,
    completedAt: null,
    ...over,
  }) as Task;

const reproduce = (over: Partial<Task> = {}) => task({ kind: 'reproduce', ...over });
const fix = (over: Partial<Task> = {}) =>
  task({ id: 'tsk_fix', kind: 'fix', dependsOnIds: ['tsk_x'], ...over });

describe('groupTasksByIssue', () => {
  it('pairs the reproduce and fix Tasks under one issue', () => {
    const groups = groupTasksByIssue([reproduce(), fix()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.attempts.at(-1)?.reproduce?.kind).toBe('reproduce');
    expect(groups[0]!.attempts.at(-1)?.fix?.kind).toBe('fix');
  });

  it('ignores non-triage tasks (no issueRef / standard kind)', () => {
    const groups = groupTasksByIssue([
      task({ kind: 'standard', issueRef: null }),
      reproduce(),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('pulls issue metadata from promptVars', () => {
    const groups = groupTasksByIssue([
      reproduce({
        promptVars: {
          issue_number: 12389,
          issue_title: 'convertToOpenAIChatMessages bug',
          issue_url: 'https://github.com/vercel/ai/issues/12389',
        },
      }),
    ]);
    expect(groups[0]).toMatchObject({
      issueNumber: 12389,
      title: 'convertToOpenAIChatMessages bug',
      url: 'https://github.com/vercel/ai/issues/12389',
    });
  });

  it('falls back to the issueRef number when promptVars lack it', () => {
    const groups = groupTasksByIssue([reproduce({ promptVars: null })]);
    expect(groups[0]!.issueNumber).toBe(12389);
    expect(groups[0]!.title).toBe('vercel/ai#12389');
  });

  it('groups multiple issues separately and sorts active work first', () => {
    const groups = groupTasksByIssue([
      reproduce({ issueRef: 'vercel/ai#1', status: 'resolved', verdict: { reproduced: false, summary: '' } }),
      reproduce({ issueRef: 'vercel/ai#2', status: 'resolved', verdict: { reproduced: true, summary: '' } }),
      fix({ issueRef: 'vercel/ai#2', dependsOnIds: [] }),
    ]);
    expect(groups.map((g) => g.issueRef)).toEqual(['vercel/ai#2', 'vercel/ai#1']);
  });

  it('groups multiple attempts on the same issue into separate attempt entries, oldest first (regression: previously the second attempt silently overwrote the first)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const later = new Date('2026-01-02T00:00:00.000Z');

    const reproduce1 = task({
      issueRef: 'acme/api#1',
      kind: 'reproduce',
      status: 'resolved',
      verdict: { reproduced: false, summary: 'could not reproduce on attempt 1' },
      createdAt: now,
    });
    const reproduce2 = task({
      issueRef: 'acme/api#1',
      kind: 'reproduce',
      status: 'running',
      createdAt: later,
    });

    const groups = groupTasksByIssue([reproduce1, reproduce2]);

    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.attempts).toHaveLength(2);
    expect(group.attempts[0]!.index).toBe(1);
    expect(group.attempts[0]!.reproduce).toBe(reproduce1);
    expect(group.attempts[0]!.fix).toBeNull();
    expect(group.attempts[1]!.index).toBe(2);
    expect(group.attempts[1]!.reproduce).toBe(reproduce2);
    expect(group.attempts[1]!.fix).toBeNull();
    // The row-level headline reflects the NEWEST attempt (still reproducing).
    expect(group.headline).toBe('reproducing');
  });

  it('pairs reproduce and fix tasks into the same attempt by creation order, not by task id', () => {
    const t1 = new Date('2026-01-01T00:00:00.000Z');
    const t2 = new Date('2026-01-02T00:00:00.000Z');

    const reproduce1 = task({
      issueRef: 'acme/api#2',
      kind: 'reproduce',
      status: 'resolved',
      verdict: { reproduced: true, summary: 'reproduced on attempt 1' },
      createdAt: t1,
    });
    const fix1 = task({
      issueRef: 'acme/api#2',
      kind: 'fix',
      status: 'merged',
      createdAt: t1,
    });
    const reproduce2 = task({
      issueRef: 'acme/api#2',
      kind: 'reproduce',
      status: 'resolved',
      verdict: { reproduced: true, summary: 'reproduced on attempt 2' },
      createdAt: t2,
    });
    const fix2 = task({
      issueRef: 'acme/api#2',
      kind: 'fix',
      status: 'needs_human',
      createdAt: t2,
    });

    // Deliberately out of chronological order in the input array — pairing must
    // key off createdAt, not array position.
    const groups = groupTasksByIssue([fix2, reproduce1, fix1, reproduce2]);

    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.attempts).toHaveLength(2);
    expect(group.attempts[0]!.reproduce).toBe(reproduce1);
    expect(group.attempts[0]!.fix).toBe(fix1);
    expect(group.attempts[1]!.reproduce).toBe(reproduce2);
    expect(group.attempts[1]!.fix).toBe(fix2);
    expect(group.headline).toBe('fix_review');
  });

  it('does not confuse attempts across two different issues in the same task list', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const r1 = task({ issueRef: 'acme/api#1', kind: 'reproduce', createdAt: now });
    const r2 = task({ issueRef: 'acme/api#2', kind: 'reproduce', createdAt: now });

    const groups = groupTasksByIssue([r1, r2]);

    expect(groups).toHaveLength(2);
    const g1 = groups.find((g) => g.issueRef === 'acme/api#1')!;
    const g2 = groups.find((g) => g.issueRef === 'acme/api#2')!;
    expect(g1.attempts).toHaveLength(1);
    expect(g1.attempts[0]!.reproduce).toBe(r1);
    expect(g2.attempts).toHaveLength(1);
    expect(g2.attempts[0]!.reproduce).toBe(r2);
  });
});

describe('headlineFor', () => {
  it('is reproducing while the reproduce Task runs', () => {
    expect(headlineFor(reproduce({ status: 'running' }), null)).toBe('reproducing');
  });

  it('is not_reproduced when the verdict is negative', () => {
    const r = reproduce({ status: 'resolved', verdict: { reproduced: false, summary: 'x' } });
    expect(headlineFor(r, null)).toBe('not_reproduced');
  });

  it('is fixing once the bug reproduced and the fix is moving', () => {
    const r = reproduce({ status: 'resolved', verdict: { reproduced: true, summary: 'x' } });
    expect(headlineFor(r, fix({ status: 'running' }))).toBe('fixing');
  });

  it('is fixed when the fix PR merged', () => {
    const r = reproduce({ status: 'resolved', verdict: { reproduced: true, summary: 'x' } });
    expect(headlineFor(r, fix({ status: 'merged' }))).toBe('fixed');
  });

  it('is fix_skipped when the fix was abandoned (bug did not reproduce)', () => {
    const r = reproduce({ status: 'resolved', verdict: { reproduced: false, summary: 'x' } });
    expect(headlineFor(r, fix({ status: 'abandoned' }))).toBe('fix_skipped');
  });

  it('is failed when the reproduce Task failed with no verdict', () => {
    expect(headlineFor(reproduce({ status: 'abandoned' }), null)).toBe('failed');
  });
});
