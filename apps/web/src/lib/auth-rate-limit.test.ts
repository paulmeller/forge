import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_IP_ADDRESS_HEADERS,
  guardRateLimitEvasion,
  isValidClientIp,
  rateLimitedResponse,
  resolveRateLimitIp,
} from './auth-rate-limit';

/**
 * The behaviour under test is "a request better-auth could not have rate
 * limited is refused instead of served". Everything here is expressed in
 * production terms — `nodeEnv: 'production'` — because the dev/test loopback
 * substitution is itself part of the mirror and is pinned separately.
 */
// `testEnv: ''` rather than undefined: vitest sets `process.env.TEST=true`,
// and better-auth's `isTest()` honours it, so leaving it unset here would fall
// through to the ambient value and every one of these would read as test.
const PROD = { nodeEnv: 'production', testEnv: '' } as const;

const headers = (init: Record<string, string> = {}) => new Headers(init);

describe('resolveRateLimitIp mirrors better-auth getIp', () => {
  it('resolves a plain IPv4 client address', () => {
    expect(resolveRateLimitIp(headers({ 'x-forwarded-for': '203.0.113.7' }), PROD)).toBe(
      '203.0.113.7',
    );
  });

  it('resolves an IPv6 client address', () => {
    expect(resolveRateLimitIp(headers({ 'x-forwarded-for': '2001:db8::1' }), PROD)).toBe(
      '2001:db8::1',
    );
  });

  it('takes the first element of a comma-separated chain, as getIp does', () => {
    // Cloud Run appends, so on a well-behaved request the first element IS the
    // client and the rest are proxies. This is also exactly why the header is
    // spoofable — the guard does not fix that, it only removes the "no limit
    // at all" outcome.
    expect(
      resolveRateLimitIp(headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }), PROD),
    ).toBe('203.0.113.7');
  });

  it('tolerates the whitespace a proxy chain usually carries', () => {
    expect(resolveRateLimitIp(headers({ 'x-forwarded-for': '  203.0.113.7 , 10.0.0.1' }), PROD)).toBe(
      '203.0.113.7',
    );
  });

  it('returns null when the first element is not an IP — the Cloud Run append case', () => {
    // The exploit, verbatim: attacker sends `X-Forwarded-For: x`; Cloud Run
    // appends the real address; better-auth reads `x`, fails isValidIP, and
    // skips rate limiting for the whole router.
    expect(resolveRateLimitIp(headers({ 'x-forwarded-for': 'x, 203.0.113.7' }), PROD)).toBeNull();
  });

  it('returns null for a hostname in the first element rather than resolving it', () => {
    expect(
      resolveRateLimitIp(headers({ 'x-forwarded-for': 'evil.example.com, 203.0.113.7' }), PROD),
    ).toBeNull();
  });

  it('returns null for an empty first element', () => {
    expect(resolveRateLimitIp(headers({ 'x-forwarded-for': ', 203.0.113.7' }), PROD)).toBeNull();
  });

  it('returns null when the header is absent entirely in production', () => {
    expect(resolveRateLimitIp(headers(), PROD)).toBeNull();
  });

  it('does NOT fall through to a later element of the same header', () => {
    // getIp does not either. Pinned because "just scan the rest of the chain"
    // is the obvious-looking improvement, and it would key the limiter on a
    // value the caller can equally choose, while making the guard silent.
    expect(resolveRateLimitIp(headers({ 'x-forwarded-for': 'x, 198.51.100.9' }), PROD)).toBeNull();
  });

  it('substitutes loopback in test and development, exactly as getIp does', () => {
    // Without this a local `next dev` browser — which sends no
    // X-Forwarded-For — would be refused on every auth request. It is not a
    // bypass: better-auth applies the same substitution, so the limiter is
    // not being skipped in those environments either.
    for (const nodeEnv of ['test', 'dev', 'development']) {
      expect(resolveRateLimitIp(headers(), { nodeEnv, testEnv: '' })).toBe('127.0.0.1');
    }
    expect(resolveRateLimitIp(headers(), { nodeEnv: 'production', testEnv: 'true' })).toBe(
      '127.0.0.1',
    );
  });

  it('reads the headers it is configured with, not a hardcoded name', () => {
    expect(
      resolveRateLimitIp(headers({ 'cf-connecting-ip': '203.0.113.7' }), {
        ...PROD,
        ipAddressHeaders: ['cf-connecting-ip'],
      }),
    ).toBe('203.0.113.7');
    // …and the default list is the one the limiter is configured with.
    expect(AUTH_IP_ADDRESS_HEADERS).toEqual(['x-forwarded-for']);
  });
});

describe('isValidClientIp', () => {
  it('accepts IPv4 and IPv6', () => {
    expect(isValidClientIp('203.0.113.7')).toBe(true);
    expect(isValidClientIp('::1')).toBe(true);
  });

  it('rejects the shapes an attacker would put first in the chain', () => {
    for (const bad of ['x', '', 'evil.example.com', '999.999.999.999', '203.0.113.7:443', '0x7f']) {
      expect(isValidClientIp(bad), bad).toBe(false);
    }
  });
});

describe('guardRateLimitEvasion', () => {
  const req = (path: string, init?: RequestInit) =>
    new Request(`https://forge.test/api/auth${path}`, init);

  /**
   * The guard reads NODE_ENV at call time, so these stub it to 'production'
   * rather than passing an option in. The dev/test loopback substitution is
   * real behaviour, not a test artefact — asserting through an injected env
   * would prove only that the injection worked.
   */
  const inProduction = () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TEST', '');
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses /device/code when the client IP cannot be resolved', async () => {
    inProduction();

    const refusal = guardRateLimitEvasion(
      req('/device/code', { method: 'POST', headers: { 'x-forwarded-for': 'x, 203.0.113.7' } }),
    );

    // Not null: better-auth would have skipped limiting for this request
    // entirely, so serving it is the thing being fixed.
    expect(refusal).not.toBeNull();
    expect(refusal?.status).toBe(429);
    expect(refusal?.statusText).toBe('Too Many Requests');
    expect(refusal?.headers.get('X-Retry-After')).toBe('60');
    expect(await refusal?.json()).toEqual({
      message: 'Too many requests. Please try again later.',
    });
  });

  it('refuses /sign-in/email on the same header, not just the device endpoints', () => {
    // The same one header disables the default 3-per-10s password-guessing
    // budget. Narrowing the guard to /device/code would leave that open.
    inProduction();

    expect(
      guardRateLimitEvasion(
        req('/sign-in/email', { method: 'POST', headers: { 'x-forwarded-for': 'x, 203.0.113.7' } }),
      ),
    ).not.toBeNull();
  });

  it('refuses a production request that carries no X-Forwarded-For at all', () => {
    inProduction();

    expect(guardRateLimitEvasion(req('/device/code', { method: 'POST' }))).not.toBeNull();
  });

  it('lets a request with a resolvable client IP through in production', () => {
    inProduction();

    expect(
      guardRateLimitEvasion(req('/device/code', { headers: { 'x-forwarded-for': '203.0.113.7' } })),
    ).toBeNull();
  });

  it('lets a local request through under test/dev, where getIp substitutes loopback', () => {
    expect(guardRateLimitEvasion(req('/sign-in/email', { method: 'POST' }))).toBeNull();
  });

  it('emits the same refusal shape better-auth emits, so a client needs one case', async () => {
    const refusal = rateLimitedResponse();
    expect(refusal.status).toBe(429);
    expect(await refusal.json()).toEqual({ message: 'Too many requests. Please try again later.' });
  });
});
