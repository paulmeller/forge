import { randomUUID, timingSafeEqual } from 'node:crypto';

import { eq } from '@forge/db/orm';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { githubInstallations } from '@forge/db';

import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { userHasInstallationAccess } from '@/lib/github-app-auth';
import { syncGithubInstallation } from '@/lib/github-installation-sync';
import { getOptionalUser } from '@/lib/with-auth';

import { INSTALL_STATE_COOKIE } from '../install/route';

/** Constant-time compare that also tolerates length mismatch. */
function statesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Ask GitHub whether this user can see this installation, using the GitHub
 * token better-auth stored at sign-in. getAccessToken refreshes it when
 * expired, so a session older than GitHub's 8h user-token lifetime still
 * verifies. Any failure to obtain a token is "not authorized", not an error.
 */
async function userOwnsInstallation(userId: string, installationId: number): Promise<boolean> {
  let token: string | undefined;
  try {
    const result = await auth.api.getAccessToken({
      body: { providerId: 'github', userId },
    });
    token = result?.accessToken;
  } catch {
    return false;
  }
  if (!token) return false;
  return userHasInstallationAccess(token, installationId);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GitHub App installation callback.
 *
 * After a user installs the Forge GitHub App, GitHub redirects here with
 * ?installation_id=NNN&setup_action=install.
 *
 * If the user is logged in, we store the installation. If not, we redirect
 * to login with a returnTo URL that preserves the installation_id.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const installationIdStr = url.searchParams.get('installation_id');

  if (!installationIdStr) {
    return NextResponse.redirect(new URL('/setup', url.origin));
  }

  const installationId = Number(installationIdStr);
  const state = url.searchParams.get('state') ?? undefined;

  const user = await getOptionalUser();
  if (!user) {
    // Redirect to login, preserving installation_id *and* state — the state
    // cookie outlives the login round-trip, so the check below still applies
    // once they come back.
    const returnTo =
      `/api/github/callback?installation_id=${installationId}` +
      (state ? `&state=${encodeURIComponent(state)}` : '');
    return NextResponse.redirect(
      new URL(`/login?returnTo=${encodeURIComponent(returnTo)}`, url.origin),
    );
  }

  // Authorization: prove this installation belongs to this user. Installation
  // ids are sequential integers, so without a check any signed-in user could
  // claim an unclaimed id belonging to someone else and, via the sync below,
  // pull in their repo list.
  //
  // Two ways to satisfy it. The state cookie is the fast path, but it only
  // exists for installs started from /api/github/install. GitHub also calls
  // this URL with no state at all — when repo access is edited from GitHub's
  // settings (setup_on_update), via the Configure button, and for installs
  // begun on the app's own GitHub page. Rejecting those outright meant the
  // most common way to install a GitHub App silently never linked.
  //
  // So when there is no matching cookie, ask GitHub directly using the user's
  // own token. That answers the ownership question properly for organisation
  // installs too, where the installation account is the org rather than the
  // user.
  const jar = await cookies();
  const expectedState = jar.get(INSTALL_STATE_COOKIE)?.value;
  let authorized = statesMatch(state, expectedState);
  // One-time use — a replayed callback must not pass on the cookie twice.
  if (expectedState) jar.delete(INSTALL_STATE_COOKIE);

  if (!authorized) {
    authorized = await userOwnsInstallation(user.id, installationId);
  }

  if (!authorized) {
    return NextResponse.redirect(new URL('/setup?error=install_not_verified', url.origin));
  }

  // Check if this installation already exists
  const [existing] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);

  let installationRowId: string;
  if (existing) {
    // Already stored — re-sync in case grants changed (e.g. "Add more repos")
    installationRowId = existing.id;
  } else {
    // Store with placeholder account details; syncGithubInstallation below
    // corrects them from GitHub's own installation record.
    const id = `ghi_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const now = new Date();

    await db.insert(githubInstallations).values({
      id,
      userId: user.id,
      installationId,
      accountLogin: user.name ?? user.email,
      accountType: 'User',
      createdAt: now,
      updatedAt: now,
    });
    installationRowId = id;
  }

  try {
    await syncGithubInstallation(installationRowId);
  } catch (err) {
    // Don't block the redirect — Setup's manual repo entry remains a
    // fallback if the GitHub sync fails (e.g. misconfigured App credentials).
    console.error('syncGithubInstallation failed', err);
  }

  return NextResponse.redirect(new URL('/setup', url.origin));
}
