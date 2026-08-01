import { createRemoteJWKSet, jwtVerify } from 'jose';

import { env } from '@/lib/env';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/**
 * Verify the Cloud Scheduler OIDC token on the tick route — failing CLOSED.
 *
 * Both expected values are mandatory unless unauthenticated ticks are enabled
 * explicitly. The previous shape passed `audience: env.TICK_EXPECTED_AUDIENCE`
 * straight through, and jose SKIPS the `aud` claim check entirely when
 * `audience` is undefined — so an unset variable silently downgraded
 * verification to "any Google-signed token for any service" while still
 * looking like enforcement (#45). Same story for the issuer-email check, which
 * was guarded by `if (env.TICK_EXPECTED_ISSUER_EMAIL && ...)`. Configuration
 * absence must be an error, never a downgrade: a misconfigured deploy now
 * fails on its first tick with a message naming the missing variable, instead
 * of running open for months.
 *
 * TICK_ALLOW_UNAUTHENTICATED=true remains the local-dev escape hatch — a
 * deliberate, visible choice, which is exactly what the silent fail-open
 * was not.
 */
export async function verifyCloudSchedulerOidc(authHeader: string | undefined): Promise<void> {
  if (env.TICK_ALLOW_UNAUTHENTICATED) return;

  const audience = env.TICK_EXPECTED_AUDIENCE;
  if (!audience) {
    throw new Error(
      'TICK_EXPECTED_AUDIENCE is not set: refusing to verify OIDC without a pinned audience (set it, or set TICK_ALLOW_UNAUTHENTICATED=true for local dev)',
    );
  }
  const issuerEmail = env.TICK_EXPECTED_ISSUER_EMAIL;
  if (!issuerEmail) {
    throw new Error(
      'TICK_EXPECTED_ISSUER_EMAIL is not set: refusing to verify OIDC without a pinned issuer (set it, or set TICK_ALLOW_UNAUTHENTICATED=true for local dev)',
    );
  }

  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('missing bearer token');
  }
  const token = authHeader.slice('Bearer '.length);

  const { payload } = await jwtVerify(token, GOOGLE_JWKS, {
    issuer: 'https://accounts.google.com',
    audience,
  });

  if (payload.email !== issuerEmail) {
    throw new Error(`unexpected issuer email: ${String(payload.email)}`);
  }
}
