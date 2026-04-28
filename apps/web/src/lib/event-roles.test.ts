import { describe, expect, it } from 'vitest';

import { extractPrUrl, roleOf, shortLabel, shouldExpandByDefault } from './event-roles';

describe('roleOf', () => {
  it('classifies forge events', () => {
    expect(roleOf('planner.emitted')).toBe('forge');
    expect(roleOf('mission.started')).toBe('forge');
    expect(roleOf('dispatcher.dispatched')).toBe('forge');
    expect(roleOf('task.abandoned')).toBe('forge');
    expect(roleOf('ci.passed')).toBe('forge');
  });

  it('classifies session events', () => {
    expect(roleOf('session.status_idle')).toBe('session');
    expect(roleOf('session.error')).toBe('session');
  });

  it('classifies model events', () => {
    expect(roleOf('span.model_request_start')).toBe('model');
    expect(roleOf('span.model_request_end')).toBe('model');
  });

  it('classifies agent events including user.* (sent by orchestrator on behalf of agent)', () => {
    expect(roleOf('agent.message')).toBe('agent');
    expect(roleOf('agent.thinking')).toBe('agent');
    expect(roleOf('agent.tool_use')).toBe('agent');
    expect(roleOf('agent.mcp_tool_result')).toBe('agent');
    expect(roleOf('user.message')).toBe('agent');
  });

  it('falls through to forge for unknown', () => {
    expect(roleOf('completely.unknown')).toBe('forge');
  });
});

describe('shouldExpandByDefault', () => {
  it('collapses noisy events', () => {
    expect(shouldExpandByDefault('agent.thinking')).toBe(false);
    expect(shouldExpandByDefault('agent.tool_use')).toBe(false);
    expect(shouldExpandByDefault('agent.tool_result')).toBe(false);
    expect(shouldExpandByDefault('span.model_request_start')).toBe(false);
    expect(shouldExpandByDefault('span.model_request_end')).toBe(false);
    expect(shouldExpandByDefault('session.status_idle')).toBe(false);
    expect(shouldExpandByDefault('session.status_running')).toBe(false);
  });

  it('expands signal events', () => {
    expect(shouldExpandByDefault('agent.message')).toBe(true);
    expect(shouldExpandByDefault('agent.mcp_tool_result')).toBe(true);
    expect(shouldExpandByDefault('mission.started')).toBe(true);
    expect(shouldExpandByDefault('dispatcher.dispatched')).toBe(true);
    expect(shouldExpandByDefault('ci.passed')).toBe(true);
    expect(shouldExpandByDefault('ci.failed')).toBe(true);
  });
});

describe('shortLabel', () => {
  it('strips role prefix', () => {
    expect(shortLabel('agent.message')).toBe('message');
    expect(shortLabel('mission.completed')).toBe('completed');
  });

  it('uses overrides for span names', () => {
    expect(shortLabel('span.model_request_start')).toBe('request_start');
    expect(shortLabel('span.model_request_end')).toBe('request_end');
  });

  it('returns the full type when prefix doesnt yield a remainder', () => {
    expect(shortLabel('agent.')).toBe('agent.');
  });
});

describe('extractPrUrl', () => {
  it('finds PR URL in a payload string field', () => {
    const pr = extractPrUrl({ text: 'See https://github.com/acme/api/pull/42' });
    expect(pr).toEqual({ url: 'https://github.com/acme/api/pull/42', number: 42 });
  });

  it('finds PR URL inside nested content blocks', () => {
    const pr = extractPrUrl({
      content: [{ type: 'text', text: 'Done: https://github.com/owner/repo/pull/7' }],
    });
    expect(pr).toEqual({ url: 'https://github.com/owner/repo/pull/7', number: 7 });
  });

  it('finds PR URL inside an MCP result object', () => {
    const pr = extractPrUrl({ result: { html_url: 'https://github.com/o/r/pull/12' } });
    expect(pr?.number).toBe(12);
  });

  it('returns null when no URL present', () => {
    expect(extractPrUrl({ content: [{ type: 'text', text: 'hello' }] })).toBeNull();
    expect(extractPrUrl(null)).toBeNull();
    expect(extractPrUrl('not an object')).toBeNull();
  });

  it('handles unserializable values without throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => extractPrUrl(cyclic)).not.toThrow();
  });
});
