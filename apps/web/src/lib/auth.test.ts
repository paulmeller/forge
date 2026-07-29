import { describe, expect, it } from 'vitest';

import { isAllowedDeviceClient, rejectDeviceScope } from './device-auth';

// These assertions are on the REAL options object `betterAuth()` was
// constructed with — not on a copy of the config restated here. A test that
// rebuilt the intended shape locally would keep passing after someone deleted
// the wiring, which is the failure mode this file exists to prevent.
const { auth } = await import('./auth');

type LoadedPlugin = {
  id: string;
  options?: {
    validateClient?: unknown;
    onDeviceAuthRequest?: unknown;
    verificationUri?: string;
    expiresIn?: string;
  };
};

const plugins = (auth.options.plugins ?? []) as unknown as LoadedPlugin[];
const devicePlugin = plugins.find((p) => p.id === 'device-authorization');

describe('the device-authorization plugin is registered with its preconditions met', () => {
  it('is registered', () => {
    expect(devicePlugin).toBeDefined();
  });

  it('keeps the bearer plugin registered alongside it', () => {
    // /api/v1 authenticates with `Authorization: Bearer <session token>`;
    // the device flow is how a CLI obtains that token, so removing bearer
    // would make the whole flow pointless.
    expect(plugins.map((p) => p.id)).toContain('bearer');
  });

  it('supplies the client allow-list as validateClient', () => {
    // Identity, not "is a function": the allow-list behaviour is pinned in
    // device-auth.test.ts, and this asserts that THAT function is the one
    // better-auth will call.
    expect(devicePlugin?.options?.validateClient).toBe(isAllowedDeviceClient);
  });

  it('supplies the scope rejection as onDeviceAuthRequest', () => {
    expect(devicePlugin?.options?.onDeviceAuthRequest).toBe(rejectDeviceScope);
  });

  it('points the verification URI at the consent page', () => {
    expect(devicePlugin?.options?.verificationUri).toMatch(/\/device$/);
  });

  it('keeps the code lifetime short', () => {
    // Not the plugin's 30m default. The window this bounds is the one for
    // someone who OBSERVED a code they cannot re-mint — the plugin's
    // `verification_uri_complete` carries `?user_code=…`, so a CLI that
    // prints it leaks the code into logs, history and Referer, and a reader
    // of those can approve it as themselves (session fixation). An attacker
    // in conversation with the victim just mints a fresh code, so this is not
    // a phishing control; see the note in auth.ts.
    expect(devicePlugin?.options?.expiresIn).toBe('5m');
  });
});

describe('the plugin endpoints whose ownership guard cannot fire are switched off', () => {
  // `deviceApprove`/`deviceDeny` guard with
  // `if (record.userId && record.userId !== session.user.id)`, which never
  // fires on a fresh row (userId NULL). Forge approves through
  // decideDeviceRequest instead, so these must not be reachable over HTTP —
  // otherwise the broken guard is back as a second, weaker way in.
  it('disables /device/approve', () => {
    expect(auth.options.disabledPaths).toContain('/device/approve');
  });

  it('disables /device/deny', () => {
    expect(auth.options.disabledPaths).toContain('/device/deny');
  });

  it('leaves the machine-facing endpoints reachable', () => {
    const disabled = auth.options.disabledPaths ?? [];
    expect(disabled).not.toContain('/device/code');
    expect(disabled).not.toContain('/device/token');
  });
});

describe('the unauthenticated device-status oracle is switched off', () => {
  /**
   * `deviceVerify` is `GET /api/auth/device?user_code=…`. It takes no session,
   * and it answers differently for a code that does not exist, one that has
   * expired, and one that is pending / approved / denied. That is a free
   * confirmation oracle for a secret: it tells a holder of a guessed or
   * shoulder-surfed code whether it is real, still live, and whether a human
   * has acted on it. Nothing in Forge calls it.
   */
  it('disables /device', () => {
    expect(auth.options.disabledPaths).toContain('/device');
  });

  it('matches the plugin path exactly, so /device/code and /device/token survive', () => {
    // better-auth's `onRequest` does `disabledPaths.includes(normalizedPath)` —
    // exact string equality, not a prefix test. This pins that reading: if it
    // were a prefix match, disabling '/device' would have silently killed the
    // whole flow and every other device test here would still pass.
    const disabled = auth.options.disabledPaths ?? [];
    expect(disabled).not.toContain('/device/code');
    expect(disabled).not.toContain('/device/token');
  });
});

describe('the session list is not reachable over HTTP', () => {
  /**
   * `/list-sessions` returns each session row as-is, and the core `token`
   * field carries no `returned: false` — better-auth's output filter strips
   * only fields marked that way, so the raw credential goes to the caller.
   * The bearer plugin turns that token straight back into a session, so one
   * XSS on any authenticated page, or one leaked CLI token, harvests every
   * session in the account. The device-issued session is the worst of them:
   * it is long-lived and survives the victim signing the browser out.
   *
   * /sessions reaches the same data through `auth.api.listSessions`
   * in-process, which `disabledPaths` does not affect — so switching the HTTP
   * route off costs Forge nothing.
   */
  it('disables /list-sessions', () => {
    expect(auth.options.disabledPaths).toContain('/list-sessions');
  });

  it('leaves revoke-session reachable — it takes a token, it does not hand one out', () => {
    expect(auth.options.disabledPaths ?? []).not.toContain('/revoke-session');
  });
});

describe('rate limiting for the device endpoints', () => {
  // Widened deliberately: the inferred type is the literal set of keys that
  // are present, so asking whether an *absent* key is absent would be a type
  // error rather than the assertion it is.
  const rules: Record<string, unknown> = auth.options.rateLimit?.customRules ?? {};

  it('caps /device/code, which is unauthenticated and creates a row per call', () => {
    expect(rules['/device/code']).toBeDefined();
  });

  it('caps /device/token, which is the polling endpoint', () => {
    expect(rules['/device/token']).toBeDefined();
  });

  it('does not carry a dead rule for the disabled /device path', () => {
    // `onRequest` returns 404 for a disabled path before the limiter is
    // consulted, so a rule here would never run. Keeping one would read like
    // an active control.
    expect(rules['/device']).toBeUndefined();
  });

  it('pins the header the client IP is read from rather than leaving it implicit', () => {
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual(['x-forwarded-for']);
  });

  it('leaves IP tracking on, which resolveRateLimitIp (auth-rate-limit.ts) assumes', () => {
    // better-auth's private `getIp` opens with
    // `if (options.advanced?.ipAddress?.disableIpTracking) return null;`, which
    // makes onRequestRateLimit treat every request as unresolvable and skip
    // its limiter router-wide. resolveRateLimitIp has no equivalent
    // short-circuit, so if this were ever set, guardRateLimitEvasion would
    // keep resolving IPs and waving requests through while better-auth's own
    // limiting was silently off — the hole guardRateLimitEvasion exists to
    // close, reopened. Pin it off rather than leave it implicit.
    expect(auth.options.advanced?.ipAddress?.disableIpTracking).toBeUndefined();
  });
});
