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
