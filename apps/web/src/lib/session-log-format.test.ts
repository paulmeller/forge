import { describe, expect, it } from 'vitest';

import {
  formatLogLine,
  isErrorLogEvent,
  isToolEvent,
  normalizeRawSessionEvent,
} from './session-log-format';

describe('formatLogLine', () => {
  it('formats agent.message from its text content block', () => {
    const line = formatLogLine({
      eventType: 'agent.message',
      payload: { content: [{ type: 'text', text: 'Hello from the agent' }] },
    });
    expect(line).toBe('[assistant] Hello from the agent');
  });

  it('truncates long agent.message text to 300 chars with an ellipsis', () => {
    const longText = 'a'.repeat(400);
    const line = formatLogLine({
      eventType: 'agent.message',
      payload: { content: [{ type: 'text', text: longText }] },
    });
    expect(line).toBe(`[assistant] ${'a'.repeat(300)}…`);
  });

  it('formats agent.thinking as a fixed label (no content in real payloads)', () => {
    const line = formatLogLine({ eventType: 'agent.thinking', payload: { seq: 3 } });
    expect(line).toBe('[thinking…]');
  });

  it('formats agent.tool_use with the tool name and input.description', () => {
    const line = formatLogLine({
      eventType: 'agent.tool_use',
      payload: {
        name: 'Agent',
        input: { description: 'Explore agentstep/product repo structure' },
      },
    });
    expect(line).toBe('[tool] Agent — Explore agentstep/product repo structure');
  });

  it('formats agent.tool_use with just the name when input has no description', () => {
    const line = formatLogLine({
      eventType: 'agent.tool_use',
      payload: { name: 'Bash', input: { command: 'ls' } },
    });
    expect(line).toBe('[tool] Bash');
  });

  it('formats agent.tool_result with exit code and stdout', () => {
    const line = formatLogLine({
      eventType: 'agent.tool_result',
      payload: {
        content: { exitCode: 0, stdout: '(Bash completed with no output)' },
        is_error: false,
      },
    });
    expect(line).toBe('[tool result] exit 0 — (Bash completed with no output)');
  });

  it('formats agent.tool_result as an error when is_error is true and no exit code', () => {
    const line = formatLogLine({
      eventType: 'agent.tool_result',
      payload: { content: {}, is_error: true },
    });
    expect(line).toBe('[tool result] error');
  });

  it('formats session.error from error.message', () => {
    const line = formatLogLine({
      eventType: 'session.error',
      payload: { error: { type: 'server_error', message: 'container creation failed' } },
    });
    expect(line).toBe('[error] container creation failed');
  });

  it('formats session.status_* events', () => {
    expect(formatLogLine({ eventType: 'session.status_running', payload: {} })).toBe(
      '[session] running',
    );
    expect(formatLogLine({ eventType: 'session.status_idle', payload: {} })).toBe(
      '[session] idle',
    );
  });

  it('formats user.message from its text content block', () => {
    const line = formatLogLine({
      eventType: 'user.message',
      payload: { content: [{ type: 'text', text: 'Triage open issues in acme/api' }] },
    });
    expect(line).toBe('[user] Triage open issues in acme/api');
  });

  it('falls back to a generic [forge] line for Forge-synthetic event types', () => {
    expect(
      formatLogLine({ eventType: 'dispatcher.dispatched', payload: { sessionId: 'sesn_1' } }),
    ).toBe('[forge] dispatcher.dispatched');
    expect(formatLogLine({ eventType: 'workspace.issue.enqueued', payload: {} })).toBe(
      '[forge] workspace.issue.enqueued',
    );
  });

  it('handles missing/malformed payload fields without throwing', () => {
    expect(() => formatLogLine({ eventType: 'agent.message', payload: null })).not.toThrow();
    expect(() => formatLogLine({ eventType: 'agent.tool_use', payload: {} })).not.toThrow();
    expect(formatLogLine({ eventType: 'agent.message', payload: null })).toBe('[assistant] ');
  });
});

describe('isToolEvent', () => {
  it('is true for agent.tool_use and agent.tool_result', () => {
    expect(isToolEvent({ eventType: 'agent.tool_use', payload: {} })).toBe(true);
    expect(isToolEvent({ eventType: 'agent.tool_result', payload: {} })).toBe(true);
  });

  it('is false for other event types', () => {
    expect(isToolEvent({ eventType: 'agent.message', payload: {} })).toBe(false);
    expect(isToolEvent({ eventType: 'dispatcher.dispatched', payload: {} })).toBe(false);
  });
});

describe('isErrorLogEvent', () => {
  it('is true for session.error', () => {
    expect(isErrorLogEvent({ eventType: 'session.error', payload: {} })).toBe(true);
  });

  it('is true for a failed tool_result via is_error', () => {
    expect(
      isErrorLogEvent({ eventType: 'agent.tool_result', payload: { is_error: true, content: {} } }),
    ).toBe(true);
  });

  it('is true for a failed tool_result via a non-zero exit code', () => {
    expect(
      isErrorLogEvent({
        eventType: 'agent.tool_result',
        payload: { is_error: false, content: { exitCode: 1 } },
      }),
    ).toBe(true);
  });

  it('is false for a successful tool_result', () => {
    expect(
      isErrorLogEvent({
        eventType: 'agent.tool_result',
        payload: { is_error: false, content: { exitCode: 0 } },
      }),
    ).toBe(false);
  });

  it('is false for unrelated event types', () => {
    expect(isErrorLogEvent({ eventType: 'agent.message', payload: {} })).toBe(false);
    expect(isErrorLogEvent({ eventType: 'session.status_running', payload: {} })).toBe(false);
  });
});

describe('normalizeRawSessionEvent', () => {
  it('maps a raw engine SSE event into the LedgerEvent-like shape', () => {
    const raw = {
      id: 'sevt_abc123',
      type: 'agent.message',
      processed_at: '2026-07-16T10:00:00.000Z',
      content: [{ type: 'text', text: 'hi' }],
      seq: 5,
    };
    const normalized = normalizeRawSessionEvent(raw);
    expect(normalized.id).toBe('sevt_abc123');
    expect(normalized.eventType).toBe('agent.message');
    expect(normalized.payload).toBe(raw);
    expect(normalized.createdAt).toEqual(new Date('2026-07-16T10:00:00.000Z'));
  });

  it('falls back to a generated id and the current time when fields are missing', () => {
    const normalized = normalizeRawSessionEvent({});
    expect(normalized.id).toMatch(/^live_/);
    expect(normalized.eventType).toBe('unknown');
    expect(normalized.createdAt).toBeInstanceOf(Date);
  });

  it('handles a non-object input without throwing', () => {
    expect(() => normalizeRawSessionEvent(null)).not.toThrow();
    expect(() => normalizeRawSessionEvent('not an object')).not.toThrow();
  });
});
