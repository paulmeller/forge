import { createRemoteJWKSet, jwtVerify } from 'jose';

import { env } from './env';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export async function verifyCloudSchedulerOidc(authHeader: string | undefined): Promise<void> {
  if (env.TICK_ALLOW_UNAUTHENTICATED) return;

  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('missing bearer token');
  }
  const token = authHeader.slice('Bearer '.length);

  const { payload } = await jwtVerify(token, GOOGLE_JWKS, {
    issuer: 'https://accounts.google.com',
    audience: env.TICK_EXPECTED_AUDIENCE,
  });

  if (env.TICK_EXPECTED_ISSUER_EMAIL && payload.email !== env.TICK_EXPECTED_ISSUER_EMAIL) {
    throw new Error(`unexpected issuer email: ${String(payload.email)}`);
  }
}
