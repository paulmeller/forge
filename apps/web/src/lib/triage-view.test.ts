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
    expect(groups[0]!.reproduce?.kind).toBe('reproduce');
    expect(groups[0]!.fix?.kind).toBe('fix');
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
