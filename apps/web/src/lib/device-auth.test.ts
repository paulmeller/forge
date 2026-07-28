import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { FORGE_DEVICE_CLIENT_IDS: undefined as string | undefined },
}));

vi.mock('@/lib/env', () => ({ env: mocks.env }));
vi.mock('@/lib/db', () => ({ db: {} }));

const {
  FORGE_CLI_CLIENT_ID,
  allowedDeviceClientIds,
  isAllowedDeviceClient,
  rejectDeviceScope,
  normalizeUserCode,
} = await import('./device-auth');

beforeEach(() => {
  mocks.env.FORGE_DEVICE_CLIENT_IDS = undefined;
});

describe('the device-flow client allow-list', () => {
  // Both directions, deliberately. A single negative test would pass just as
  // happily against `return false` as against a real allow-list lookup, and a
  // single positive test would pass against `return true` — which is exactly
  // the unvalidated `client_id` this option exists to fix.
  it('accepts the first-party CLI client id', () => {
    expect(isAllowedDeviceClient(FORGE_CLI_CLIENT_ID)).toBe(true);
  });

  it('rejects a client id that is not on the list', () => {
    expect(isAllowedDeviceClient('attacker-cli')).toBe(false);
  });

  it('rejects the empty client id', () => {
    expect(isAllowedDeviceClient('')).toBe(false);
  });

  it('matches exactly — a prefix of an allowed id is not allowed', () => {
    expect(isAllowedDeviceClient(`${FORGE_CLI_CLIENT_ID}-evil`)).toBe(false);
    expect(isAllowedDeviceClient(FORGE_CLI_CLIENT_ID.slice(0, 3))).toBe(false);
  });

  it('defaults to exactly the first-party client when nothing is configured', () => {
    expect(allowedDeviceClientIds()).toEqual([FORGE_CLI_CLIENT_ID]);
  });

  it('lets an operator extend the list through FORGE_DEVICE_CLIENT_IDS', () => {
    mocks.env.FORGE_DEVICE_CLIENT_IDS = 'forge-cli, acme-deploy-bot';
    expect(allowedDeviceClientIds()).toEqual(['forge-cli', 'acme-deploy-bot']);
    expect(isAllowedDeviceClient('acme-deploy-bot')).toBe(true);
    // Extending the list must not turn it into an allow-everything.
    expect(isAllowedDeviceClient('attacker-cli')).toBe(false);
  });

  it('falls back to the first-party client when the env var is set but empty', () => {
    mocks.env.FORGE_DEVICE_CLIENT_IDS = '  ,  ';
    expect(allowedDeviceClientIds()).toEqual([FORGE_CLI_CLIENT_ID]);
    expect(isAllowedDeviceClient('attacker-cli')).toBe(false);
  });
});

describe('scope rejection at /device/code', () => {
  // The API has no scopes. Storing and echoing one would tell an integrator
  // the issued token is constrained when it is an ordinary full-power
  // session, so a scoped request must fail outright.
  it('rejects a non-empty scope with a 400', () => {
    try {
      rejectDeviceScope(FORGE_CLI_CLIENT_ID, 'missions:read');
      expect.unreachable('rejectDeviceScope should have thrown');
    } catch (err) {
      expect((err as { status?: string | number }).status).toBe('BAD_REQUEST');
      expect((err as { statusCode?: number }).statusCode).toBe(400);
      expect((err as { body?: { error?: string } }).body?.error).toBe('invalid_request');
      expect(String((err as Error).message)).toMatch(/scope/i);
    }
  });

  it('rejects a scope that only looks empty', () => {
    expect(() => rejectDeviceScope(FORGE_CLI_CLIENT_ID, '   ')).toThrow();
  });

  // The other direction: an unscoped request is the supported case and must
  // still work, or the whole flow is dead.
  it('allows a request with no scope at all', () => {
    expect(() => rejectDeviceScope(FORGE_CLI_CLIENT_ID, undefined)).not.toThrow();
  });

  it('allows a request with an empty-string scope', () => {
    expect(() => rejectDeviceScope(FORGE_CLI_CLIENT_ID, '')).not.toThrow();
  });
});

describe('normalizeUserCode', () => {
  it('upper-cases and strips the display separators a human types', () => {
    expect(normalizeUserCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeUserCode('  abcd efgh \n')).toBe('ABCDEFGH');
  });

  it('drops everything that is not part of the code alphabet', () => {
    expect(normalizeUserCode("ab'cd/efgh")).toBe('ABCDEFGH');
  });

  it('returns an empty string for input with nothing code-like in it', () => {
    expect(normalizeUserCode('   ')).toBe('');
    expect(normalizeUserCode('---')).toBe('');
  });
});
