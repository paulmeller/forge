import { randomBytes } from 'node:crypto';

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { withAuth } from '@/lib/with-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cookie holding the one-time CSRF state for a GitHub App install. */
export const INSTALL_STATE_COOKIE = 'forge_gh_install_state';

/**
 * Starts a GitHub App installation.
 *
 * This exists so the install can carry an OAuth `state` value. Without one,
 * /api/github/callback has no way to tell that the person completing the
 * callback is the person who performed the install — installation ids are
 * sequential integers, so anyone logged in could claim an unclaimed id
 * belonging to someone else and pull in their repo list.
 *
 * The state is minted here, stored in an httpOnly cookie, and echoed back by
 * GitHub on the redirect; the callback requires the two to match. A route
 * handler rather than a link in the page because a Server Component cannot
 * set cookies during render.
 */
export async function GET() {
  // Binds the pending install to a signed-in user from the outset.
  await withAuth();

  const state = randomBytes(32).toString('hex');

  const jar = await cookies();
  jar.set(INSTALL_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // 'lax', not 'strict': the callback arrives as a top-level GET navigation
    // from github.com, and 'strict' would withhold the cookie on it.
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 10,
  });

  const target = new URL(`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`);
  target.searchParams.set('state', state);

  return NextResponse.redirect(target, { headers: { 'cache-control': 'no-store' } });
}
