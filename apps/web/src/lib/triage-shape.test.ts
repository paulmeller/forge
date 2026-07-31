import { describe, expect, it } from 'vitest';

import { needsReproduce } from './triage-shape';

const bug = { title: 'fix: live run view is broken in production', labels: ['bug'], body: 'It 500s.' };

describe('needsReproduce', () => {
  // A reproduce phase asks "does this bug reproduce?" and settles on a verdict.
  // For a feature request that question has no honest answer, so the Task cannot
  // succeed by construction — observed live on #67 ("build a validator"), where
  // the reproduce agent sensibly built the feature and was then abandoned for
  // emitting no verdict, orphaning 488 lines (#70).
  it('is true for a labelled bug', () => {
    expect(needsReproduce(bug)).toBe(true);
  });

  it('is false for a feature request', () => {
    expect(
      needsReproduce({ title: 'feat: add a cost dashboard', labels: ['enhancement'], body: 'Show spend.' }),
    ).toBe(false);
  });

  it('is false for a chore or docs change', () => {
    expect(needsReproduce({ title: 'chore: bump eslint', labels: [], body: '' })).toBe(false);
    expect(needsReproduce({ title: 'feat(gates): risk-proportional gate policy', labels: [] })).toBe(false);
    expect(needsReproduce({ title: 'docs: explain the tick', labels: ['documentation'], body: '' })).toBe(false);
  });

  it('trusts an explicit bug label over a conventional-commit prefix', () => {
    // Maintainers label deliberately; a title prefix is a weaker signal.
    expect(needsReproduce({ title: 'feat: retry logic drops events', labels: ['bug'], body: '' })).toBe(true);
  });

  it('reads a fix/bug title prefix when labels are absent', () => {
    expect(needsReproduce({ title: 'fix: webhook creates two missions', labels: [], body: '' })).toBe(true);
  });

  it('KEEPS the reproduce phase when the issue gives no signal', () => {
    // Most real bug reports are a descriptive title and prose with no label and
    // no prefix. Defaulting the other way would silently disable reproduction
    // for the majority of genuine bugs — a far bigger change than #70 asked for.
    expect(needsReproduce({ title: 'the thing in the sidebar', labels: [], body: 'please look at it' })).toBe(true);
    expect(
      needsReproduce({ title: 'convertToOpenAIChatMessages sends content: "" instead of null', labels: [] }),
    ).toBe(true);
  });

  it('is not fooled by the word "bug" inside prose', () => {
    expect(
      needsReproduce({ title: 'feat: add a bug-report template', labels: ['enhancement'], body: '' }),
    ).toBe(false);
  });
});
