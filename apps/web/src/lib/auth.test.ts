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

describe('rate limiting for the device endpoints', () => {
  const rules = auth.options.rateLimit?.customRules ?? {};

  it('caps /device/code, which is unauthenticated and creates a row per call', () => {
    expect(rules['/device/code']).toBeDefined();
  });

  it('caps /device/token, which is the polling endpoint', () => {
    expect(rules['/device/token']).toBeDefined();
  });

  it('caps the /device status lookup', () => {
    expect(rules['/device']).toBeDefined();
  });

  it('pins the header the client IP is read from rather than leaving it implicit', () => {
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual(['x-forwarded-for']);
  });
});
