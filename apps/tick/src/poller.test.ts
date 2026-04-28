import { describe, expect, it } from 'vitest';

import type { StateTransition } from './state';
import { AUTO_ALLOW_TOOLS, hasAnyDelta, mergeDelta } from './poller';

describe('mergeDelta', () => {
  it('merges two empty deltas', () => {
    expect(mergeDelta({}, {})).toEqual({
      status: undefined,
      prUrl: undefined,
      prNumber: undefined,
      costTokensDelta: 0,
      lastError: undefined,
      completed: undefined,
    });
  });

  it('second delta status wins over first', () => {
    const a: StateTransition = { status: 'running' };
    const b: StateTransition = { status: 'turn_ended' };
    expect(mergeDelta(a, b).status).toBe('turn_ended');
  });

  it('preserves first delta status when second has none', () => {
    const a: StateTransition = { status: 'running' };
    const b: StateTransition = { costTokensDelta: 100 };
    expect(mergeDelta(a, b).status).toBe('running');
  });

  it('accumulates costTokensDelta', () => {
    const a: StateTransition = { costTokensDelta: 500 };
    const b: StateTransition = { costTokensDelta: 300 };
    expect(mergeDelta(a, b).costTokensDelta).toBe(800);
  });

  it('handles undefined costTokensDelta as 0', () => {
    const a: StateTransition = {};
    const b: StateTransition = { costTokensDelta: 200 };
    expect(mergeDelta(a, b).costTokensDelta).toBe(200);
  });

  it('preserves prUrl from earlier delta when later has none', () => {
    const a: StateTransition = { prUrl: 'https://github.com/o/r/pull/1', prNumber: 1 };
    const b: StateTransition = { costTokensDelta: 50 };
    const merged = mergeDelta(a, b);
    expect(merged.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(merged.prNumber).toBe(1);
  });

  it('later prUrl overrides earlier', () => {
    const a: StateTransition = { prUrl: 'https://github.com/o/r/pull/1', prNumber: 1 };
    const b: StateTransition = { prUrl: 'https://github.com/o/r/pull/2', prNumber: 2 };
    expect(mergeDelta(a, b).prUrl).toBe('https://github.com/o/r/pull/2');
  });

  it('later lastError overrides earlier', () => {
    const a: StateTransition = { lastError: 'first' };
    const b: StateTransition = { lastError: 'second' };
    expect(mergeDelta(a, b).lastError).toBe('second');
  });

  it('later completed flag overrides earlier', () => {
    const a: StateTransition = {};
    const b: StateTransition = { completed: true };
    expect(mergeDelta(a, b).completed).toBe(true);
  });
});

describe('hasAnyDelta', () => {
  it('returns false for empty delta', () => {
    expect(hasAnyDelta({})).toBe(false);
  });

  it('detects status change', () => {
    expect(hasAnyDelta({ status: 'running' })).toBe(true);
  });

  it('detects prUrl', () => {
    expect(hasAnyDelta({ prUrl: 'https://github.com/o/r/pull/1' })).toBe(true);
  });

  it('detects prNumber', () => {
    expect(hasAnyDelta({ prNumber: 42 })).toBe(true);
  });

  it('detects positive costTokensDelta', () => {
    expect(hasAnyDelta({ costTokensDelta: 100 })).toBe(true);
  });

  it('ignores zero costTokensDelta', () => {
    expect(hasAnyDelta({ costTokensDelta: 0 })).toBe(false);
  });

  it('detects lastError', () => {
    expect(hasAnyDelta({ lastError: 'boom' })).toBe(true);
  });

  it('detects completed flag', () => {
    expect(hasAnyDelta({ completed: true })).toBe(true);
  });
});

describe('AUTO_ALLOW_TOOLS', () => {
  it('allows create_pull_request', () => {
    expect(AUTO_ALLOW_TOOLS.has('create_pull_request')).toBe(true);
  });

  it('allows create_pull_request_review_comment', () => {
    expect(AUTO_ALLOW_TOOLS.has('create_pull_request_review_comment')).toBe(true);
  });

  it('allows add_issue_comment', () => {
    expect(AUTO_ALLOW_TOOLS.has('add_issue_comment')).toBe(true);
  });

  it('allows create_or_update_file', () => {
    expect(AUTO_ALLOW_TOOLS.has('create_or_update_file')).toBe(true);
  });

  it('blocks merge_pull_request (destructive)', () => {
    expect(AUTO_ALLOW_TOOLS.has('merge_pull_request')).toBe(false);
  });

  it('blocks delete_branch (destructive)', () => {
    expect(AUTO_ALLOW_TOOLS.has('delete_branch')).toBe(false);
  });

  it('blocks push_files (destructive)', () => {
    expect(AUTO_ALLOW_TOOLS.has('push_files')).toBe(false);
  });

  it('blocks arbitrary tool names', () => {
    expect(AUTO_ALLOW_TOOLS.has('execute_shell')).toBe(false);
    expect(AUTO_ALLOW_TOOLS.has('')).toBe(false);
  });
});
