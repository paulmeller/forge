import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    FORGE_DEVICE_CLIENT_IDS: undefined as string | undefined,
    BETTER_AUTH_SECRET: 'test-secret-for-consent-tokens',
  },
}));

vi.mock('@/lib/env', () => ({ env: mocks.env }));
vi.mock('@/lib/db', () => ({ db: {} }));

const {
  FORGE_CLI_CLIENT_ID,
  allowedDeviceClientIds,
  isAllowedDeviceClient,
  issueDeviceConsentToken,
  rejectDeviceScope,
  normalizeUserCode,
  verifyDeviceConsentToken,
} = await import('./device-auth');

beforeEach(() => {
  mocks.env.FORGE_DEVICE_CLIENT_IDS = undefined;
  mocks.env.BETTER_AUTH_SECRET = 'test-secret-for-consent-tokens';
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

/**
 * The consent token is what makes the two-step consent page two steps
 * *server-side*. Without it, one request carrying `{userCode, op:'approve'}`
 * and a valid session cookie is a completed approval, and "the human typed the
 * code first" is a claim only the browser makes.
 */
describe('the device consent token', () => {
  const CODE = 'ABCD2345';
  const USER = 'usr_alice';

  it('verifies a token it just minted for the same code and user', () => {
    // The positive case first: a check that only ever rejects would pass every
    // negative test below while breaking the page completely.
    expect(verifyDeviceConsentToken(issueDeviceConsentToken(CODE, USER), CODE, USER)).toBe(true);
  });

  it('rejects a token minted for a different code', () => {
    // The whole point: an attacker's code cannot be approved with a token
    // obtained by looking up some other code.
    expect(verifyDeviceConsentToken(issueDeviceConsentToken('ZZZZ9999', USER), CODE, USER)).toBe(
      false,
    );
  });

  it('rejects a token minted by a different user', () => {
    expect(verifyDeviceConsentToken(issueDeviceConsentToken(CODE, 'usr_bob'), CODE, USER)).toBe(
      false,
    );
  });

  it('accepts the code in whatever punctuation the human typed', () => {
    // The token is bound to the normalized code, and verification normalizes
    // too, so a hyphenated resubmission of the same code still verifies.
    const token = issueDeviceConsentToken(CODE, USER);
    expect(verifyDeviceConsentToken(token, 'abcd-2345', USER)).toBe(true);
  });

  it('rejects a token that has expired', () => {
    const issuedAt = 1_000_000_000_000;
    const token = issueDeviceConsentToken(CODE, USER, issuedAt);

    expect(verifyDeviceConsentToken(token, CODE, USER, issuedAt + 60_000)).toBe(true);
    expect(verifyDeviceConsentToken(token, CODE, USER, issuedAt + 5 * 60 * 1000)).toBe(false);
    expect(verifyDeviceConsentToken(token, CODE, USER, issuedAt + 60 * 60 * 1000)).toBe(false);
  });

  it('rejects a token whose expiry has been pushed out without re-signing', () => {
    // The obvious forgery: keep the signature, edit the deadline. The expiry
    // is inside the signed message, so it does not verify.
    const issuedAt = 1_000_000_000_000;
    const token = issueDeviceConsentToken(CODE, USER, issuedAt);
    const [, signature] = token.split('.');
    const forged = `${issuedAt + 10 * 60 * 60 * 1000}.${signature}`;

    expect(verifyDeviceConsentToken(forged, CODE, USER, issuedAt + 60_000)).toBe(false);
  });

  it('rejects a signature signed with a different server secret', () => {
    const token = issueDeviceConsentToken(CODE, USER);
    mocks.env.BETTER_AUTH_SECRET = 'some-other-secret';
    expect(verifyDeviceConsentToken(token, CODE, USER)).toBe(false);
  });

  it('rejects malformed tokens rather than throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, and a hand-written token
    // is the easiest way to hit that. Each of these must be a quiet `false`.
    for (const bad of [
      '',
      '.',
      'not-a-token',
      'abc.def',
      `.${issueDeviceConsentToken(CODE, USER).split('.')[1]}`,
      `${Date.now() + 60_000}.`,
      `${Date.now() + 60_000}.short`,
      ` ${Date.now() + 60_000}.sig`,
      `0x${(Date.now() + 60_000).toString(16)}.sig`,
      `${Number.MAX_SAFE_INTEGER}0.sig`,
    ]) {
      expect(verifyDeviceConsentToken(bad, CODE, USER), JSON.stringify(bad)).toBe(false);
    }
  });

  it('does not put the user code or the user id in the clear', () => {
    // It is rendered into a hidden form field, so it should not restate the
    // secret the page exists to protect.
    const token = issueDeviceConsentToken(CODE, USER);
    expect(token).not.toContain(CODE);
    expect(token).not.toContain(USER);
  });
});
