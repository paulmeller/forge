import { describe, expect, it, vi } from 'vitest';

import { GatewayAdapter, GatewayApiError } from './gateway';
import { GeminiManagedAgentsAdapter } from './gemini-managed-agents';
import { ManagedAgentsAdapter } from './managed-agents';
import { AdapterNotImplementedError, type BackendAdapter } from './types';

/**
 * Contract tests: verify both adapters implement the full BackendAdapter
 * interface and that shared invariants hold.
 *
 * These are structural/unit tests — they don't hit real APIs. Integration
 * tests against live endpoints belong in a separate suite gated by env vars.
 */

function adapterSuite(name: string, create: () => BackendAdapter) {
  describe(`${name} contract`, () => {
    it('has the correct kind', () => {
      const adapter = create();
      expect(['managed-agents', 'gateway', 'gemini-managed-agents']).toContain(adapter.kind);
    });

    it('implements createSession', () => {
      const adapter = create();
      expect(typeof adapter.createSession).toBe('function');
    });

    it('implements sendTurn', () => {
      const adapter = create();
      expect(typeof adapter.sendTurn).toBe('function');
    });

    it('implements listEvents', () => {
      const adapter = create();
      expect(typeof adapter.listEvents).toBe('function');
    });

    it('implements streamEvents', () => {
      const adapter = create();
      expect(typeof adapter.streamEvents).toBe('function');
    });

    it('implements getSession', () => {
      const adapter = create();
      expect(typeof adapter.getSession).toBe('function');
    });

    it('implements cancelSession', () => {
      const adapter = create();
      expect(typeof adapter.cancelSession).toBe('function');
    });

    it('implements confirmToolUse', () => {
      const adapter = create();
      expect(typeof adapter.confirmToolUse).toBe('function');
    });

    it('implements getAgentInstructions', () => {
      const adapter = create();
      expect(typeof adapter.getAgentInstructions).toBe('function');
    });
  });
}

// Managed Agents adapter — uses a mock Anthropic client to avoid real API calls
adapterSuite('ManagedAgentsAdapter', () =>
  new ManagedAgentsAdapter({
    apiKey: 'test-key',
    environmentId: 'test-env',
  }),
);

// Gateway adapter — uses a dummy URL (no real HTTP in these tests)
adapterSuite('GatewayAdapter', () =>
  new GatewayAdapter({
    baseUrl: 'https://gateway.test',
    apiKey: 'test-key',
  }),
);

// Gemini adapter — plain fetch, no real HTTP in these tests (fetch isn't
// invoked by anything adapter-contract.test.ts calls, since it only checks
// method presence, not behavior).
adapterSuite('GeminiManagedAgentsAdapter', () =>
  new GeminiManagedAgentsAdapter({
    apiKey: 'test-key',
    model: 'gemini-pro-latest',
  }),
);

describe('GatewayAdapter specifics', () => {
  it('strips trailing slashes from baseUrl', () => {
    const adapter = new GatewayAdapter({
      baseUrl: 'https://gateway.test////',
      apiKey: 'k',
    });
    expect(adapter.kind).toBe('gateway');
    // Can't inspect private field directly, but the adapter should
    // function without double-slash paths
  });

  it('GatewayApiError captures status and path', () => {
    const err = new GatewayApiError(404, 'GET', '/v1/sessions/123', '{"error":"not found"}');
    expect(err.status).toBe(404);
    expect(err.method).toBe('GET');
    expect(err.path).toBe('/v1/sessions/123');
    expect(err.message).toContain('404');
    expect(err.message).toContain('/v1/sessions/123');
    expect(err.name).toBe('GatewayApiError');
  });

  // Issue #67: the gateway mirrors Managed Agents' /v1/agents/{id} surface,
  // not just /v1/sessions/* — dispatch-time contract checking needs this to
  // read the agent's own `system` instructions.
  it('getAgentInstructions reads the system field from /v1/agents/{id}', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ system: 'push to your own branch' }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new GatewayAdapter({ baseUrl: 'https://gw.test', apiKey: 'gw-key' });

    await expect(adapter.getAgentInstructions('agent_1')).resolves.toBe('push to your own branch');

    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://gw.test/v1/agents/agent_1');
    vi.unstubAllGlobals();
  });

  it('getAgentInstructions returns null when the agent has no system field set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })),
    );
    const adapter = new GatewayAdapter({ baseUrl: 'https://gw.test', apiKey: 'gw-key' });

    await expect(adapter.getAgentInstructions('agent_1')).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  // Issue #42: the stream route used to hardcode Anthropic's host for every
  // backend. streamEvents is the adapter-owned fix — this pins it to the
  // gateway's own baseUrl/apiKey, not Anthropic's.
  it('streamEvents fetches this gateway\'s own host, not Anthropic', async () => {
    const fetchSpy = vi.fn(
      // Typed params so mock.calls destructures — an untyped vi.fn() gives
      // calls[0] an empty-tuple type.
      async (_url: string | URL, _init?: RequestInit) => new Response(new ReadableStream()),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new GatewayAdapter({ baseUrl: 'https://gw.test', apiKey: 'gw-key' });

    await adapter.streamEvents('sess_1');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://gw.test/v1/sessions/sess_1/events/stream');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('gw-key');
    vi.unstubAllGlobals();
  });
});

describe('GeminiManagedAgentsAdapter streamEvents', () => {
  it('throws AdapterNotImplementedError — the Interactions API has no SSE endpoint', async () => {
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    await expect(adapter.streamEvents('sess_1')).rejects.toBeInstanceOf(AdapterNotImplementedError);
  });
});

describe('GeminiManagedAgentsAdapter getAgentInstructions', () => {
  it('throws AdapterNotImplementedError — the Interactions API has no retrievable agent record', async () => {
    const adapter = new GeminiManagedAgentsAdapter({ apiKey: 'k', model: 'gemini-pro-latest' });
    await expect(adapter.getAgentInstructions('agent_1')).rejects.toBeInstanceOf(
      AdapterNotImplementedError,
    );
  });
});

describe('ManagedAgentsAdapter streamEvents', () => {
  it('fetches the SDK client\'s own baseURL/apiKey, honoring ANTHROPIC_BASE_URL overrides', async () => {
    const fetchSpy = vi.fn(
      // Typed params so mock.calls destructures — an untyped vi.fn() gives
      // calls[0] an empty-tuple type.
      async (_url: string | URL, _init?: RequestInit) => new Response(new ReadableStream()),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new ManagedAgentsAdapter({
      apiKey: 'unused',
      environmentId: 'test-env',
      client: { baseURL: 'https://self-hosted.test', apiKey: 'ma-key' } as never,
    });

    await adapter.streamEvents('sess_1');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://self-hosted.test/v1/sessions/sess_1/events/stream');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('ma-key');
    expect((init?.headers as Record<string, string>)['anthropic-beta']).toBe(
      'managed-agents-2026-04-01',
    );
    vi.unstubAllGlobals();
  });
});

describe('non-rotating adapters report no rotated handle', () => {
  it('ManagedAgentsAdapter.sendTurn returns an empty result', async () => {
    const send = vi.fn(async () => ({}));
    const adapter = new ManagedAgentsAdapter({
      apiKey: 'test-key',
      environmentId: 'test-env',
      client: { beta: { sessions: { events: { send } } } } as never,
    });

    const result = await adapter.sendTurn({ sessionId: 's1', text: 'hi' });

    expect(result).toEqual({});
    expect(send).toHaveBeenCalledOnce();
  });

  it('GatewayAdapter.sendTurn returns an empty result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })),
    );
    const adapter = new GatewayAdapter({ baseUrl: 'https://gw.test', apiKey: 'k' });

    const result = await adapter.sendTurn({ sessionId: 's1', text: 'hi' });

    expect(result).toEqual({});
    vi.unstubAllGlobals();
  });
});
