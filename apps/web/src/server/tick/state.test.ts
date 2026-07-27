import { describe, expect, it } from 'vitest';

import type { BackendEvent } from './adapters/types';
import { transition } from './state';

function event(type: string, raw: Record<string, unknown> = {}): BackendEvent {
  return {
    id: `sevt_${type}_${Math.random().toString(36).slice(2, 10)}`,
    type,
    processedAt: new Date(),
    raw: { ...raw, type, id: 'sevt_fixture' },
  };
}

describe('transition', () => {
  it('dispatching → running on session.status_running', () => {
    const t = transition('dispatching', event('session.status_running'));
    expect(t).toEqual({ status: 'running' });
  });

  it('ignores session.status_running when already running', () => {
    expect(transition('running', event('session.status_running'))).toBeNull();
  });

  it('running → turn_ended on session.status_idle with end_turn', () => {
    const t = transition(
      'running',
      event('session.status_idle', { stop_reason: { type: 'end_turn' } }),
    );
    expect(t).toEqual({ status: 'turn_ended', turnCompleted: true });
  });

  it('only the running → turn_ended transition carries turnCompleted', () => {
    // turn_ended is produced solely from `running`; a second idle while already
    // turn_ended yields no transition, so turnCompleted deltas are inherently
    // distinct (one per completed turn).
    expect(
      transition('turn_ended', event('session.status_idle', { stop_reason: { type: 'end_turn' } })),
    ).toBeNull();
    expect(
      transition('dispatching', event('session.status_running'))?.turnCompleted,
    ).toBeUndefined();
  });

  it('does not transition on session.status_idle with requires_action', () => {
    const t = transition(
      'running',
      event('session.status_idle', { stop_reason: { type: 'requires_action' } }),
    );
    expect(t).toBeNull();
  });

  it('running → abandoned on session.status_terminated with no PR yet', () => {
    const t = transition('running', event('session.status_terminated'));
    expect(t).toEqual({ status: 'abandoned', completed: true });
  });

  it('keeps awaiting_ci intact on session.status_terminated', () => {
    // Session can terminate after the PR is open; CI poller owns the transition.
    const t = transition('awaiting_ci', event('session.status_terminated'));
    expect(t).toBeNull();
  });

  it('any → failed on session.error', () => {
    const t = transition('running', event('session.error', { message: 'model refused' }));
    expect(t).toEqual({ status: 'failed', lastError: 'model refused', completed: true });
  });

  // Mirrors the session.status_terminated guard just above: a Task already
  // past the backend's reach (awaiting_ci, ready_to_merge, needs_human,
  // merged) must not be regressed to `failed` — `failed` is what
  // retryMission selects from, so this guard is a closed exploit path, not
  // just tidiness. POLLABLE_STATUSES (poller.ts) doesn't include any of
  // these today, so this is currently unreachable in practice; the guard
  // exists so widening POLLABLE_STATUSES later can't silently reopen it.
  // Revert the SETTLED_STATUSES guard on session.error and this test fails:
  // it comes back { status: 'failed', ... } instead of null.
  it('does not regress a settled Task to failed on a late session.error', () => {
    for (const current of ['awaiting_ci', 'ready_to_merge', 'needs_human', 'merged'] as const) {
      const t = transition(current, event('session.error', { message: 'late error' }));
      expect(t).toBeNull();
    }
  });

  it('captures PR URL from agent.mcp_tool_result content', () => {
    const t = transition(
      'running',
      event('agent.mcp_tool_result', {
        content: [
          {
            type: 'text',
            text: 'Pull request created: https://github.com/acme/api/pull/42',
          },
        ],
      }),
    );
    expect(t).toEqual({
      status: 'awaiting_ci',
      prUrl: 'https://github.com/acme/api/pull/42',
      prNumber: 42,
    });
  });

  it('captures PR URL from agent.mcp_tool_result result object', () => {
    const t = transition(
      'running',
      event('agent.mcp_tool_result', {
        result: { html_url: 'https://github.com/acme/web/pull/7', number: 7 },
      }),
    );
    expect(t?.status).toBe('awaiting_ci');
    expect(t?.prUrl).toBe('https://github.com/acme/web/pull/7');
    expect(t?.prNumber).toBe(7);
  });

  it('ignores a PR URL from a pull_request_read result — only create_pull_request drives the transition', () => {
    // pull_request_read also returns a PR URL in its result, but it's a read, not a
    // creation — must not be mistaken for a newly opened PR.
    const t = transition(
      'running',
      event('agent.mcp_tool_result', {
        mcp_tool_use_name: 'pull_request_read',
        content: [{ type: 'text', text: 'https://github.com/acme/api/pull/42' }],
      }),
    );
    expect(t).toBeNull();
  });

  it('captures the PR URL when mcp_tool_use_name is explicitly create_pull_request', () => {
    const t = transition(
      'running',
      event('agent.mcp_tool_result', {
        mcp_tool_use_name: 'create_pull_request',
        content: [{ type: 'text', text: 'https://github.com/acme/api/pull/99' }],
      }),
    );
    expect(t).toEqual({
      status: 'awaiting_ci',
      prUrl: 'https://github.com/acme/api/pull/99',
      prNumber: 99,
    });
  });

  it('accumulates cost tokens from span.model_request_end', () => {
    const t = transition(
      'running',
      event('span.model_request_end', {
        model_usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_creation_input_tokens: 7000,
          cache_read_input_tokens: 50,
        },
      }),
    );
    expect(t).toEqual({ costTokensDelta: 7350 });
  });

  it('returns null for unrecognized events (informational only)', () => {
    expect(transition('running', event('agent.thinking'))).toBeNull();
    expect(transition('running', event('user.message'))).toBeNull();
    expect(transition('running', event('agent.tool_use'))).toBeNull();
  });
});
