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
 * Accepts the sibling managed-agents engine's header convention so one CLI
 * can speak to both products without special-casing. Authorization wins when
 * both are present — an explicit auth header is the more specific signal.
 * The alias is all that is needed because better-auth's bearer plugin turns
 * `Authorization: Bearer` into the session cookie every ownership check
 * already reads.
 *
 * Gate on a *usable* token, not on the header's mere presence. The bearer
 * plugin bails unless the scheme is literally `bearer` (case-insensitively),
 * so `Authorization: Basic …` — HTTP Basic auth, or any proxy that injects
 * its own Authorization header — is not an identity claim this function
 * should act on. Treating it as one produced a guaranteed 401 with a valid
 * credential present: a `Basic` header plus `x-api-key` used to skip the
 * alias (because `explicit` was truthy) while still deleting the cookie.
 */
function withBearerAlias(incoming: Headers): Headers {
  const explicit = incoming.get('authorization');
  const apiKey = incoming.get('x-api-key');
  const bearerToken = explicit?.slice(0, 7).toLowerCase() === 'bearer '
    ? explicit.slice(7).trim()
    : null;
  if (!bearerToken && !apiKey) return incoming;
  const resolved = new Headers(incoming);
  if (!bearerToken && apiKey) resolved.set('authorization', `Bearer ${apiKey}`);
  // A presented token is an explicit identity claim. Leaving the cookie
  // attached lets it win silently one layer down — the bearer plugin appends
  // its synthesized cookie to the existing one and better-call's parser keeps
  // the first occurrence — so the caller would act as the cookie's user while
  // believing it acted as the token's. That is a wrong-user action, not a
  // failed one, so the cookie goes. This only runs once we know a usable
  // token exists — a Basic header (or any other scheme) with no api-key
  // takes the early return above and leaves the cookie untouched.
  resolved.delete('cookie');
  return resolved;
}

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
    session = await auth.api.getSession({ headers: withBearerAlias(await headers()) });
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
