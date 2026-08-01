import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jose's jwtVerify SKIPS the audience check entirely when `audience` is
// undefined rather than failing — that silent downgrade is the vulnerability
// this suite pins (#45). The library is mocked so the tests assert what we
// pass it and never depend on Google's JWKS endpoint.
const jwtVerify = vi.hoisted(() => vi.fn());
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => 'jwks'),
  jwtVerify,
}));

import { verifyCloudSchedulerOidc } from './oidc';

const HEADER = 'Bearer tok';

beforeEach(() => {
  jwtVerify.mockReset();
  jwtVerify.mockResolvedValue({ payload: { email: 'scheduler@proj.iam.gserviceaccount.com' } });
  process.env.TICK_ALLOW_UNAUTHENTICATED = '';
  process.env.TICK_EXPECTED_AUDIENCE = 'https://forge.example/api/tick';
  process.env.TICK_EXPECTED_ISSUER_EMAIL = 'scheduler@proj.iam.gserviceaccount.com';
});

afterEach(() => {
  delete process.env.TICK_ALLOW_UNAUTHENTICATED;
  delete process.env.TICK_EXPECTED_AUDIENCE;
  delete process.env.TICK_EXPECTED_ISSUER_EMAIL;
});

describe('verifyCloudSchedulerOidc — fail closed (#45)', () => {
  it('accepts a token with the configured audience and issuer email', async () => {
    await expect(verifyCloudSchedulerOidc(HEADER)).resolves.toBeUndefined();
    expect(jwtVerify).toHaveBeenCalledWith(
      'tok',
      expect.anything(),
      expect.objectContaining({ audience: 'https://forge.example/api/tick' }),
    );
  });

  it('refuses to verify at all when the expected audience is unset', async () => {
    // The old behaviour: audience undefined -> jose skips the aud claim ->
    // any Google-signed token for any service passes. Configuration absence
    // must be an error, never a downgrade.
    delete process.env.TICK_EXPECTED_AUDIENCE;
    await expect(verifyCloudSchedulerOidc(HEADER)).rejects.toThrow(/TICK_EXPECTED_AUDIENCE/);
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('refuses to verify when the expected issuer email is unset', async () => {
    delete process.env.TICK_EXPECTED_ISSUER_EMAIL;
    await expect(verifyCloudSchedulerOidc(HEADER)).rejects.toThrow(/TICK_EXPECTED_ISSUER_EMAIL/);
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('rejects a valid token whose issuer email is wrong', async () => {
    jwtVerify.mockResolvedValue({ payload: { email: 'attacker@other-proj.iam.gserviceaccount.com' } });
    await expect(verifyCloudSchedulerOidc(HEADER)).rejects.toThrow(/issuer email/);
  });

  it('rejects a missing bearer token', async () => {
    await expect(verifyCloudSchedulerOidc(undefined)).rejects.toThrow(/bearer/);
  });

  it('keeps the explicit local-dev escape hatch', async () => {
    // TICK_ALLOW_UNAUTHENTICATED=true is a deliberate, visible choice — the
    // opposite of the silent fail-open this issue closes.
    process.env.TICK_ALLOW_UNAUTHENTICATED = 'true';
    delete process.env.TICK_EXPECTED_AUDIENCE;
    await expect(verifyCloudSchedulerOidc(undefined)).resolves.toBeUndefined();
    expect(jwtVerify).not.toHaveBeenCalled();
  });
});
