import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import pino from 'pino';

import { auth } from './auth';
import { env } from './env';

export type ApiUser = {
  id: string;
  name: string;
  email: string;
};

const log = pino({ level: env.LOG_LEVEL });

const unauthorized = (): [null, NextResponse] => [
  null,
  NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
];

/**
 * Auth check for API route handlers. Returns the user or a 401 response.
 *
 * Reads the same better-auth session cookie as withAuth(); the two differ
 * only in how they fail. withAuth() redirects to /login, which suits a route
 * a browser navigates to. This returns 401 JSON, which is the only useful
 * answer for a caller that parses the response.
 *
 * There is deliberately no development bypass. This previously returned a
 * synthetic DEV_USER whenever NODE_ENV was 'development' and no session was
 * found, which made local behaviour diverge from production precisely at the
 * gate — every API route authenticated as 'user_default' locally while the
 * pages beside them (on withAuth, which never had a bypass) redirected to
 * /login. A gate that only engages in production is a gate you never test.
 */
export async function apiAuth(): Promise<[ApiUser, null] | [null, NextResponse]> {
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers: await headers() });
  } catch (err) {
    // Still a 401 — the caller is not authenticated either way — but an
    // adapter that is down is not the same event as a missing cookie, and
    // swallowing it silently is what made that indistinguishable.
    log.error({ err }, 'api-auth:session_lookup_failed');
    return unauthorized();
  }

  if (!session?.user) return unauthorized();

  return [
    { id: session.user.id, name: session.user.name, email: session.user.email },
    null,
  ];
}
