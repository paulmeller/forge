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

  // Authorization ALWAYS comes from GitHub, unconditionally. Installation ids
  // are sequential integers, so without asking GitHub, any signed-in user
  // could claim an unclaimed (or not-yet-existing) id belonging to someone
  // else and, via the sync below, pull in their repo list. The state cookie
  // below is CSRF protection layered on top of this — it is never a
  // substitute for it, and the two are combined with `&&`, never `||`: a
  // state match must not short-circuit the real ownership check.
  //
  // The state cookie only exists for installs started from
  // /api/github/install. GitHub also calls this URL with no state at all —
  // when repo access is edited from GitHub's settings (setup_on_update), via
  // the Configure button, and for installs begun on the app's own GitHub
  // page. So when there is no cookie at all, only the GitHub check applies;
  // when there IS a cookie, it must also match or the request is rejected
  // outright (a wrong/forged state is never given a second chance via the
  // GitHub check).
  const jar = await cookies();
  const expectedState = jar.get(INSTALL_STATE_COOKIE)?.value;
  if (expectedState) {
    // One-time use — a replayed callback must not pass on the cookie twice.
    jar.delete(INSTALL_STATE_COOKIE);
    if (!statesMatch(state, expectedState)) {
      return NextResponse.redirect(new URL('/setup?error=install_not_verified', url.origin));
    }
  }

  const authorized = await userOwnsInstallation(user.id, installationId);
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
    if (existing.userId !== user.id) {
      // A row already claims this installation for a *different* user, yet
      // userOwnsInstallation above just asked GitHub directly and GitHub
      // confirmed the CURRENT user owns installationId. The existing row is
      // therefore stale, not authoritative — most likely the "pre-claiming"
      // attack this whole check defends against: an attacker registered
      // this installation id before it existed (or before its real owner
      // ever completed this callback), syncGithubInstallation 404'd and was
      // swallowed, and the attacker's row survived untouched. Reclaim it for
      // its real, GitHub-verified owner — explicitly and audibly, not by
      // silently falling through to `installationRowId = existing.id` (the
      // bug: reusing the row leaves it bound to the attacker while the sync
      // below populates it with the real owner's repos) and not by silently
      // rebinding it with no trace either.
      console.warn(
        `github install callback: reclaiming installation ${installationId} ` +
          `(row ${existing.id}) from user ${existing.userId} to ${user.id} — ` +
          `GitHub confirmed the latter is the current owner`,
      );
      await db
        .update(githubInstallations)
        .set({ userId: user.id, updatedAt: new Date() })
        .where(eq(githubInstallations.id, existing.id));
    }
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
