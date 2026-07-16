import { describe, expect, it } from 'vitest';

/**
 * Regression test for issue #18 — GET /api/healthz
 *
 * The endpoint must:
 *  - Respond to GET requests at /api/healthz
 *  - Return HTTP 200 with Content-Type: application/json
 *  - Return body { status: 'ok', service: 'forge-web' }
 *  - Require no authentication
 */

describe('GET /api/healthz', () => {
  it('returns 200 with { status: "ok", service: "forge-web" }', async () => {
    const { GET } = await import('./route');
    const response = GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: 'ok', service: 'forge-web' });
  });

  it('does not require authentication (can be called with no request object)', async () => {
    const { GET } = await import('./route');
    // Route should work with no request argument — no auth headers needed
    const response = GET();
    expect(response.status).toBe(200);
  });
});
