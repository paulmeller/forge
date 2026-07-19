import { describe, expect, it } from 'vitest';

import type { StateTransition } from './state';
import { AUTO_ALLOW_TOOLS, hasAnyDelta, mergeDelta, progressMarkers, reduceEvents } from './poller';

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

describe('reduceEvents (per-event turn counting)', () => {
  const ev = (type: string, raw: Record<string, unknown> = {}, id = Math.random().toString()) => ({
    id,
    type,
    processedAt: null,
    raw,
  });
  const idle = (id: string) => ev('session.status_idle', { stop_reason: { type: 'end_turn' } }, id);
  const running = (id: string) => ev('session.status_running', {}, id);

  it('counts TWO turns when one poll window holds two idle→running→idle cycles', () => {
    // running → idle (turn 1) → running → idle (turn 2). mergeDelta collapses
    // the final status to turn_ended, but turnsCompleted must be 2.
    const { turnsCompleted, pendingDelta } = reduceEvents('running', [
      idle('a'),
      running('b'),
      idle('c'),
    ]);
    expect(turnsCompleted).toBe(2);
    expect(pendingDelta.status).toBe('turn_ended');
  });

  it('counts a single turn once', () => {
    expect(reduceEvents('running', [idle('a')]).turnsCompleted).toBe(1);
  });

  it('does not count turns for a task that only starts running', () => {
    expect(reduceEvents('dispatching', [running('a')]).turnsCompleted).toBe(0);
  });
});

describe('progressMarkers (no-progress clock)', () => {
  const now = new Date('2026-06-08T00:00:00.000Z');

  it('stamps on the first completed turn (clock not yet started)', () => {
    const m = progressMarkers({
      lastProgressAt: null,
      prevPrUrl: null,
      newPrUrl: undefined,
      turnsCompleted: 1,
      newCostTokens: 5000,
      now,
    });
    expect(m).toEqual({ lastProgressAt: now, costTokensAtProgress: 5000 });
  });

  it('does NOT re-stamp on later turns once the clock is running', () => {
    expect(
      progressMarkers({
        lastProgressAt: new Date('2026-06-07T00:00:00.000Z'),
        prevPrUrl: null,
        newPrUrl: undefined,
        turnsCompleted: 1,
        newCostTokens: 50_000,
        now,
      }),
    ).toBeNull();
  });

  it('stamps on the first PR attach', () => {
    const m = progressMarkers({
      lastProgressAt: new Date('2026-06-07T00:00:00.000Z'),
      prevPrUrl: null,
      newPrUrl: 'https://github.com/o/r/pull/1',
      turnsCompleted: 0,
      newCostTokens: 80_000,
      now,
    });
    expect(m).toEqual({ lastProgressAt: now, costTokensAtProgress: 80_000 });
  });

  it('a gate round-trip (no new turn, PR already attached) is NOT progress', () => {
    expect(
      progressMarkers({
        lastProgressAt: new Date('2026-06-07T00:00:00.000Z'),
        prevPrUrl: 'https://github.com/o/r/pull/1',
        newPrUrl: 'https://github.com/o/r/pull/1',
        turnsCompleted: 0,
        newCostTokens: 120_000,
        now,
      }),
    ).toBeNull();
  });
});
