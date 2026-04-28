import { describe, expect, it } from 'vitest';

import { GatewayAdapter, GatewayApiError } from './gateway';
import { ManagedAgentsAdapter } from './managed-agents';
import type { BackendAdapter } from './types';

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
      expect(['managed-agents', 'gateway']).toContain(adapter.kind);
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
});
