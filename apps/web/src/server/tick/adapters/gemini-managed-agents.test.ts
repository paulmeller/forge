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
    await adapter.sendTurn({ sessionId, text: 'continue' });
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

describe('GeminiManagedAgentsAdapter.listEvents — state-driving translation', () => {
  it('emits session.status_running on the first poll of an in_progress interaction', async () => {
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } }, // createSession
      { body: { id: 'v1_abc', status: 'in_progress', steps: [] } }, // listEvents
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const { events } = await adapter.listEvents({ sessionId });

    expect(events).toEqual([
      { id: `${sessionId}:status:running`, type: 'session.status_running', processedAt: null, raw: {} },
    ]);
  });

  it('emits session.status_idle with stop_reason end_turn when the interaction completes', async () => {
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      { body: { id: 'v1_abc', status: 'completed', steps: [] } },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const { events } = await adapter.listEvents({ sessionId });

    expect(events).toContainEqual({
      id: `${sessionId}:status:completed`,
      type: 'session.status_idle',
      processedAt: null,
      raw: { stop_reason: { type: 'end_turn' } },
    });
  });

  it.each([
    ['failed', 'session.error'],
    ['incomplete', 'session.error'],
    ['budget_exceeded', 'session.error'],
    ['requires_action', 'session.error'],
    ['cancelled', 'session.status_terminated'],
  ])('maps status %s to %s', async (status, expectedType) => {
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      { body: { id: 'v1_abc', status, steps: [] } },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const { events } = await adapter.listEvents({ sessionId });

    expect(events.some((e) => e.type === expectedType && e.id === `${sessionId}:status:${status}`)).toBe(
      true,
    );
  });

  it('does not re-emit the running transition once afterEventId has passed it', async () => {
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      { body: { id: 'v1_abc', status: 'in_progress', steps: [] } }, // first poll
      { body: { id: 'v1_abc', status: 'in_progress', steps: [] } }, // second poll, still in_progress
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const first = await adapter.listEvents({ sessionId });
    const second = await adapter.listEvents({ sessionId, afterEventId: first.latestEventId });

    expect(second.events).toEqual([]);
  });
});

describe('GeminiManagedAgentsAdapter.listEvents — observability translation', () => {
  it('translates thought/model_output/code_execution_call/code_execution_result steps, each once', async () => {
    const steps = [
      { id: 'call_1', type: 'code_execution_call', arguments: { language: 'python', code: 'ls' } },
      { call_id: 'call_1', type: 'code_execution_result', result: 'file.txt', is_error: false },
      { signature: 'sig', type: 'thought' },
      { content: [{ type: 'text', text: 'done' }], type: 'model_output' },
    ];
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      { body: { id: 'v1_abc', status: 'in_progress', steps } },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const { events } = await adapter.listEvents({ sessionId });

    // Event ids are derived from the step's array index, not id/call_id — a
    // code_execution_call and its paired code_execution_result share the same
    // call_id, so an id/call_id-keyed scheme would collide the two into the
    // same synthetic event id and silently drop one at the ledger's
    // (taskId, sourceEventId) uniqueness constraint.
    expect(events).toContainEqual(
      expect.objectContaining({ id: `${sessionId}:step:0`, type: 'agent.tool_use' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ id: `${sessionId}:step:1`, type: 'agent.tool_result' }),
    );
    expect(events.some((e) => e.type === 'agent.thinking')).toBe(true);
    expect(events.some((e) => e.type === 'agent.message')).toBe(true);
  });

  it('only emits events for steps new since the last poll', async () => {
    const stepsRoundOne = [{ id: 'call_1', type: 'code_execution_call', arguments: {} }];
    const stepsRoundTwo = [
      ...stepsRoundOne,
      { call_id: 'call_1', type: 'code_execution_result', result: 'ok', is_error: false },
    ];
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      { body: { id: 'v1_abc', status: 'in_progress', steps: stepsRoundOne } },
      { body: { id: 'v1_abc', status: 'in_progress', steps: stepsRoundTwo } },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const first = await adapter.listEvents({ sessionId });
    const second = await adapter.listEvents({ sessionId, afterEventId: first.latestEventId });

    // The result step is at absolute array index 1 (round two's second element)
    // — index-based ids, not call_id-based, per the note above.
    expect(second.events).toEqual([
      expect.objectContaining({ id: `${sessionId}:step:1`, type: 'agent.tool_result' }),
    ]);
  });
});

describe('GeminiManagedAgentsAdapter.listEvents — cost delta tracking', () => {
  it('converts cumulative usage into a per-poll delta, and never recomputes an already-appended delta', async () => {
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      {
        body: {
          id: 'v1_abc',
          status: 'in_progress',
          steps: [],
          usage: { total_input_tokens: 100, total_output_tokens: 50 },
        },
      },
      {
        body: {
          id: 'v1_abc',
          status: 'in_progress',
          steps: [],
          usage: { total_input_tokens: 150, total_output_tokens: 90 },
        },
      },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const first = await adapter.listEvents({ sessionId });
    const firstUsage = first.events.find((e) => e.type === 'span.model_request_end');
    expect(firstUsage?.raw).toEqual({ model_usage: { input_tokens: 100, output_tokens: 50 } });

    const second = await adapter.listEvents({ sessionId, afterEventId: first.latestEventId });
    const secondUsage = second.events.find((e) => e.type === 'span.model_request_end');
    expect(secondUsage?.raw).toEqual({ model_usage: { input_tokens: 50, output_tokens: 40 } });
    expect(secondUsage!.id).not.toBe(firstUsage!.id);
  });

  it('regression: a terminal-status event that newly appears in the same poll as an already-cursored usage event is not dropped by the slice', async () => {
    // This is the exact bug a fixed-position "rebuild fresh every poll" design
    // has: the terminal event and the usage event both become new at different
    // times, and once the usage event from poll 1 is used as poll 2's cursor,
    // a naive rebuild positions the terminal event "before" that cursor and
    // silently drops it. The append-only log must not have this problem.
    const { fn } = fakeFetch([
      { body: { id: 'v1_abc', status: 'in_progress' } },
      {
        body: {
          id: 'v1_abc',
          status: 'in_progress',
          steps: [],
          usage: { total_input_tokens: 100, total_output_tokens: 50 },
        },
      },
      {
        body: {
          id: 'v1_abc',
          status: 'completed',
          steps: [],
          usage: { total_input_tokens: 150, total_output_tokens: 90 },
        },
      },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    const { sessionId } = await adapter.createSession(input);

    const first = await adapter.listEvents({ sessionId }); // usage event 1 appended
    const second = await adapter.listEvents({ sessionId, afterEventId: first.latestEventId });

    expect(second.events).toContainEqual({
      id: `${sessionId}:status:completed`,
      type: 'session.status_idle',
      processedAt: null,
      raw: { stop_reason: { type: 'end_turn' } },
    });
    expect(second.events.some((e) => e.type === 'span.model_request_end')).toBe(true);
  });
});

describe('GeminiManagedAgentsAdapter backendSessionRef precedence', () => {
  it('prefers a passed-in backendSessionRef over its in-memory cache', async () => {
    const { fn, calls } = fakeFetch([
      { body: { id: 'v1_first', status: 'in_progress' } }, // createSession
      { body: { id: 'v1_third', status: 'in_progress' } }, // sendTurn
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    const { sessionId } = await adapter.createSession(input);
    // Cache says v1_first; the caller supplies a newer, persisted ref.
    await adapter.sendTurn({ sessionId, text: 'go', backendSessionRef: 'v1_second' });

    const body = JSON.parse(calls[1]!.init.body as string);
    expect(body.previous_interaction_id).toBe('v1_second');
  });

  it('falls back to sessionId when the cache is empty and no ref is passed (cold-start path)', async () => {
    const { fn, calls } = fakeFetch([{ body: { status: 'cancelled' } }]);
    vi.stubGlobal('fetch', fn);
    // Fresh adapter — empty cache, exactly like a cold Cloud Run instance.
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    await adapter.cancelSession('v1_orphan');

    expect(calls[0]!.url).toContain('/v1beta/interactions/v1_orphan/cancel');
  });

  it('cancelSession targets the passed-in ref on a cold instance, not the original sessionId', async () => {
    const { fn, calls } = fakeFetch([{ body: { status: 'cancelled' } }]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    await adapter.cancelSession('v1_original', 'v1_live');

    expect(calls[0]!.url).toContain('/v1beta/interactions/v1_live/cancel');
    expect(calls[0]!.url).not.toContain('v1_original');
  });

  it('getSession targets the passed-in ref on a cold instance', async () => {
    const { fn, calls } = fakeFetch([{ body: { id: 'v1_live', status: 'completed' } }]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    await adapter.getSession('v1_original', 'v1_live');

    expect(calls[0]!.url).toContain('/v1beta/interactions/v1_live');
  });

  it('listEvents targets the passed-in ref on a cold instance', async () => {
    const { fn, calls } = fakeFetch([
      { body: { id: 'v1_live', status: 'in_progress', steps: [] } },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    await adapter.listEvents({ sessionId: 'v1_original', backendSessionRef: 'v1_live' });

    expect(calls[0]!.url).toContain('/v1beta/interactions/v1_live');
  });

  it('sendTurn returns the rotated interaction id for the caller to persist', async () => {
    const { fn } = fakeFetch([
      { body: { id: 'v1_first', status: 'in_progress' } },
      { body: { id: 'v1_second', status: 'in_progress' } },
    ]);
    vi.stubGlobal('fetch', fn);
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });

    const { sessionId } = await adapter.createSession(input);
    const result = await adapter.sendTurn({ sessionId, text: 'continue' });

    expect(result).toEqual({ backendSessionRef: 'v1_second' });
  });
});
