import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeminiManagedAgentsAdapter } from './gemini-managed-agents';

const input = {
  agentId: 'agent_1',
  repoUrl: 'https://github.com/acme/api',
  repoCloneToken: 'ghs_test_token',
  baseBranch: 'main',
  prompt: 'do it',
};

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GeminiManagedAgentsAdapter.createSession', () => {
  it('attaches only code_execution (never an MCP server) and injects the clone token via environment.network.allowlist, not the prompt', async () => {
    const { fn, calls } = fakeFetch([{ body: { id: 'v1_abc', status: 'in_progress' } }]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    const result = await adapter.createSession(input);

    expect(result).toEqual({ sessionId: 'v1_abc' });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe('gemini-pro-latest');
    expect(body.background).toBe(true);
    expect(body.tools).toEqual([{ type: 'code_execution' }]);
    expect(body.environment.network.allowlist).toContainEqual({
      domain: 'github.com',
      transform: { Authorization: 'Bearer ghs_test_token' },
    });
    expect(body.environment.network.allowlist).toContainEqual({
      domain: 'api.github.com',
      transform: { Authorization: 'Bearer ghs_test_token' },
    });
    expect(JSON.stringify(body.input)).not.toContain('ghs_test_token');
  });

  it('sends the x-goog-api-key header', async () => {
    const { fn, calls } = fakeFetch([{ body: { id: 'v1_abc', status: 'in_progress' } }]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'my-key', model: 'gemini-pro-latest' });

    await adapter.createSession(input);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('my-key');
  });
});

describe('GeminiManagedAgentsAdapter session lifecycle', () => {
  it('getSession resolves through the latest interaction id after a sendTurn', async () => {
    const { fn, calls } = fakeFetch([
      { body: { id: 'v1_first', status: 'in_progress' } }, // createSession
      { body: { id: 'v1_second', status: 'in_progress' } }, // sendTurn
      { body: { id: 'v1_second', status: 'completed' } }, // getSession
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    const { sessionId } = await adapter.createSession(input);
    await adapter.sendTurn(sessionId, 'continue');
    const session = await adapter.getSession(sessionId);

    expect(session).toEqual({ sessionId: 'v1_first', status: 'idle', stopReasonType: undefined });
    // The third call (getSession) must hit v1_second, not v1_first — Gemini
    // hands back a new interaction id on every follow-up turn.
    expect(calls[2]!.url).toContain('/v1beta/interactions/v1_second');
  });

  it('cancelSession posts to the /cancel endpoint of the latest interaction id', async () => {
    const { fn, calls } = fakeFetch([{ body: { id: 'v1_abc', status: 'in_progress' } }, { body: { status: 'cancelled' } }]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    const { sessionId } = await adapter.createSession(input);
    await adapter.cancelSession(sessionId);

    expect(calls[1]!.url).toContain('/v1beta/interactions/v1_abc/cancel');
    expect(calls[1]!.init.method).toBe('POST');
  });

  it('confirmToolUse always throws — v1 attaches no tool that should need confirmation', async () => {
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    await expect(adapter.confirmToolUse('v1_abc', 'evt_1', { result: 'allow' })).rejects.toThrow(
      /should be unreachable/,
    );
  });
});
