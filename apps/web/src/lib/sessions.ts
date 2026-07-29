import { headers } from 'next/headers';

import { auth } from './auth';

/**
 * Seeing and killing the sessions that exist in your account.
 *
 * This is the mitigation the device-authorization flow needs and could not get
 * any other way. The flow's residual risk is remote phishing (RFC 8628 §5.1):
 * an attacker starts a device authorization, tells the victim the user code,
 * and the victim — on the genuine site, at the genuine URL, with nothing
 * pre-filled — types it and approves. Nothing on the consent page can prevent
 * that, because the attacker legitimately knows the code they generated. What
 * can be done is make the result visible and reversible: `/device/token` hands
 * out an ordinary session, so an approval a user later regrets is exactly one
 * row in `session`, and killing that row ends the access.
 *
 * Two properties this file exists to hold:
 *
 *   1. **No session token reaches the browser.** `session.token` IS the
 *      credential — the bearer plugin turns it straight back into a session,
 *      and the auth route already goes to the trouble of stripping it from a
 *      response header. So the UI identifies sessions by `session.id`, and the
 *      id→token resolution happens here, server-side. Rendering tokens into a
 *      revoke form would hand every session's credential to any XSS on the
 *      page, which is a strictly worse position than not having this page.
 *   2. **The list is the scope.** `auth.api.listSessions` returns the caller's
 *      own sessions and nothing else, so resolving an id inside that list is
 *      what makes a revoke request for someone else's session a miss rather
 *      than a revocation. There is deliberately no second `userId` comparison
 *      afterwards: better-auth's `/revoke-session` performs its own owner
 *      check, and a duplicate here would silently absorb a break in either.
 */

export type ActiveSession = {
  /** Stable, non-secret handle. NOT the token — see the note above. */
  id: string;
  createdAt: Date | null;
  expiresAt: Date | null;
  /**
   * Recorded by better-auth when the session was created. For a session issued
   * by the device flow these describe the CLI that polled `/device/token`, not
   * the browser that approved it — which is what makes a device-issued session
   * recognisable in the list.
   */
  ipAddress: string | null;
  userAgent: string | null;
  /** The session making this request. Cannot be revoked from here. */
  current: boolean;
};

export type RevokeOutcome = { ok: true } | { ok: false; error: string };

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function emptyToNull(value: unknown): string | null {
  // better-auth writes '' rather than NULL when it has no ipAddress/userAgent
  // to record, and '' renders as a blank cell that reads like a bug.
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Every live session in the caller's account, newest first.
 *
 * Returns [] rather than throwing when there is no session: the page above it
 * has already been through `withAuth()`, so the only way to get here without
 * one is a race with an expiry, and an empty list is the honest rendering of
 * that.
 */
export async function listActiveSessions(): Promise<ActiveSession[]> {
  const requestHeaders = await headers();

  const [sessions, current] = await Promise.all([
    auth.api.listSessions({ headers: requestHeaders }),
    auth.api.getSession({ headers: requestHeaders }),
  ]);

  const currentId = current?.session?.id;

  return sessions
    .map((session) => ({
      id: session.id,
      createdAt: toDate(session.createdAt),
      expiresAt: toDate(session.expiresAt),
      ipAddress: emptyToNull(session.ipAddress),
      userAgent: emptyToNull(session.userAgent),
      current: session.id === currentId,
    }))
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}

/**
 * End one session by its id.
 *
 * The current session is refused rather than revoked: revoking it is signing
 * out, there is already a Sign out control for that, and doing it from here
 * would leave the page re-rendering against a session that no longer exists.
 * The point of this control is the *other* sessions — the CLI you no longer
 * recognise.
 */
export async function revokeSessionById(sessionId: string): Promise<RevokeOutcome> {
  const requestHeaders = await headers();

  const [sessions, current] = await Promise.all([
    auth.api.listSessions({ headers: requestHeaders }),
    auth.api.getSession({ headers: requestHeaders }),
  ]);

  // The lookup is scoped to the caller's own sessions, so an id belonging to
  // anyone else simply is not here. This is the resolution step, not a second
  // ownership check bolted in front of better-auth's.
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) {
    return { ok: false, error: 'That session is no longer active.' };
  }

  if (target.id === current?.session?.id) {
    return { ok: false, error: 'That is the session you are using right now — sign out instead.' };
  }

  await auth.api.revokeSession({ headers: requestHeaders, body: { token: target.token } });

  return { ok: true };
}
