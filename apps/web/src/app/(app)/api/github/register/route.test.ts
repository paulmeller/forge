import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as register } from './route';
import { GET as registerCallback } from './callback/route';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setNodeEnv(value: string) {
  // NODE_ENV is readonly in the Next type defs; the routes read it at request
  // time, so overriding the runtime value is what actually matters here.
  (process.env as Record<string, string>).NODE_ENV = value;
}

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV as string);
  vi.restoreAllMocks();
});

describe('GitHub App manifest bootstrap routes', () => {
  it('404s the manifest step in production', async () => {
    setNodeEnv('production');
    const res = await register(new Request('https://forge.example/api/github/register'));
    expect(res.status).toBe(404);
  });

  it('404s the callback step in production without exchanging the code', async () => {
    setNodeEnv('production');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await registerCallback(
      new Request('https://forge.example/api/github/register/callback?code=abc'),
    );
    expect(res.status).toBe(404);
    // The gate must precede the GitHub call — otherwise a production request
    // still drives an app conversion, it just hides the result.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves the manifest form in development', async () => {
    setNodeEnv('development');
    const res = await register(new Request('http://localhost:3100/api/github/register'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('escapes GitHub-supplied fields and forbids caching the credentials page', async () => {
    setNodeEnv('development');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 1,
          name: '<img src=x onerror=alert(1)>',
          slug: 'forge',
          client_id: 'Iv1.abc',
          client_secret: 'secret',
          pem: 'PEMBODY',
          webhook_secret: 'whsec',
        }),
        { status: 200 },
      ),
    );
    const res = await registerCallback(
      new Request('http://localhost:3100/api/github/register/callback?code=abc'),
    );
    expect(res.status).toBe(200);
    // A private key in the body must never be cacheable.
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.text();
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
