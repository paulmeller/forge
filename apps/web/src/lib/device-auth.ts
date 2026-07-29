import { createHmac, timingSafeEqual } from 'node:crypto';

import { APIError } from 'better-auth/api';
import { and, eq } from 'drizzle-orm';

import { deviceCode } from '@forge/db';

import { db } from './db';
import { env } from './env';

/**
 * The device-authorization flow's server-side rules — everything about it that
 * Forge decides rather than better-auth.
 *
 * Three of these functions close the preconditions recorded beside `plugins:`
 * in ./auth.ts:
 *   - `isAllowedDeviceClient` is the plugin's `validateClient`, so an unknown
 *     `client_id` is rejected at `/device/code` before a row exists;
 *   - `rejectDeviceScope` is the plugin's `onDeviceAuthRequest`, so a scoped
 *     request fails instead of being stored and echoed back over an ordinary
 *     unscoped session;
 *   - `decideDeviceRequest` is the *only* approval path in the system. The
 *     plugin's own `/device/approve` and `/device/deny` are turned off via
 *     `disabledPaths` (see ./auth.ts) because their ownership guard —
 *     `if (record.userId && record.userId !== session.user.id)` — cannot fire
 *     on a freshly created row, whose `userId` is NULL.
 */

/** The one first-party client: Forge's own CLI. */
export const FORGE_CLI_CLIENT_ID = 'forge-cli';

/**
 * The allow-list. A single first-party entry is the whole product surface
 * today, but an operator running a second trusted client shouldn't need a code
 * change and a deploy to add it, so the list is an env var with the
 * first-party id as its default.
 *
 * A set-but-unusable value (empty, or only separators) falls back to the
 * default rather than yielding an empty list: an empty allow-list would reject
 * everything including the first-party CLI, which is a confusing way to
 * discover a typo. It never falls *open*.
 */
export function allowedDeviceClientIds(): string[] {
  const configured = env.FORGE_DEVICE_CLIENT_IDS;
  if (!configured) return [FORGE_CLI_CLIENT_ID];
  const ids = configured
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? ids : [FORGE_CLI_CLIENT_ID];
}

/**
 * The plugin's `validateClient`. Exact match only — no prefixes, no wildcards.
 */
export function isAllowedDeviceClient(clientId: string): boolean {
  return allowedDeviceClientIds().includes(clientId);
}

/**
 * The plugin's `onDeviceAuthRequest`, used here purely as a rejection point.
 *
 * `/device/token` issues `createSession(user.id)` — an ordinary, full-power
 * session — and then echoes the requested `scope` back beside it. Accepting a
 * scope would therefore tell a CLI author that asking for `missions:read` got
 * them a token limited to reading missions, when in fact it can delete the
 * account. Forge has no scopes, so the honest answer to a scoped request is a
 * 400. Runs before the row is created, so nothing is persisted.
 */
export function rejectDeviceScope(_clientId: string, scope: string | undefined): void {
  // Absent or literally empty is the only accepted shape. A whitespace-only
  // value is rejected rather than trimmed to nothing: it would otherwise be
  // stored and echoed back verbatim by `/device/token`, which is the exact
  // "we accepted your scope" signal this function exists to avoid sending.
  if (scope === undefined || scope.length === 0) return;
  throw new APIError('BAD_REQUEST', {
    error: 'invalid_request',
    error_description:
      'scope is not supported: this deployment issues unscoped session tokens, so a scoped device authorization cannot be honoured. Omit the scope parameter.',
    message:
      'scope is not supported: this deployment issues unscoped session tokens, so a scoped device authorization cannot be honoured. Omit the scope parameter.',
  });
}

/**
 * What a human typed → what the row is keyed by.
 *
 * The generated user code is 8 characters from
 * `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, and is displayed with a hyphen in the
 * middle, so a person will type spaces, hyphens and lower case. Everything
 * outside `[A-Z0-9]` is dropped after upper-casing; nothing is *substituted*
 * (no 0→O or 1→I), because the alphabet deliberately contains no lookalike
 * pairs and inventing a mapping would let one typed string match two codes.
 */
export function normalizeUserCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * ── The consent token ─────────────────────────────────────────────────────
 *
 * The consent page is two steps: type the code, then see what it is and decide.
 * Without something carried between them, only the *client* knows step 1
 * happened. Server-side, `decideDeviceRequest` would accept a bare
 * `{userCode, decision}` from anyone holding a valid session cookie — "the
 * human typed it first" would be a story the browser tells and the server
 * never checks.
 *
 * That is not exploitable today: better-auth's session cookie is `sameSite:
 * 'lax'` and Next's Server Action handler performs its own Origin check. But
 * Next explicitly permits a Server Action request that carries **no** Origin
 * header at all, and both of those are ambient properties rather than
 * decisions this feature made. A same-origin injection, a future
 * `serverActions.allowedOrigins` entry, or a proxy that strips Origin would
 * each turn "approve the attacker's device code" into a single request with no
 * click. This makes step 2 depend on step 1 in the only place that counts.
 *
 * `issueDeviceConsentToken` is minted by `findDeviceRequest` — i.e. only after
 * a lookup that required the typed code to resolve to a live, pending,
 * allow-listed request — and `decideDeviceRequest` refuses without a matching
 * one.
 *
 * Design notes, each load-bearing:
 *
 *   - It is an HMAC, not a stored nonce. A stored nonce would need a table, a
 *     migration and a sweep; this needs neither and is stateless across
 *     instances, which matters on Cloud Run where consecutive requests may hit
 *     different containers.
 *   - It covers `(userCode, userId, expiry)`. `userCode` so a token minted for
 *     one request cannot decide another; `userId` so a token minted in one
 *     account is worthless in another; `expiry` so a captured token stops
 *     working.
 *   - The key is `BETTER_AUTH_SECRET`, the secret this app already has, with a
 *     domain-separation prefix in the message so a signature here can never be
 *     confused with anything else signed under the same key. Inventing a
 *     second secret would add an operator step that, forgotten, fails open or
 *     fails to boot.
 *   - Comparison is `timingSafeEqual`.
 *
 * What it is NOT: it does not prove the human is the person who started the
 * flow on the device — nothing on this page can, see the note in ./auth.ts. It
 * proves this browser completed step 1, in this account, recently.
 */
const CONSENT_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Domain separation. Prefixed into the signed message so a value signed for
 * device consent cannot be replayed as, or collide with, anything else ever
 * signed with `BETTER_AUTH_SECRET`.
 */
const CONSENT_TOKEN_DOMAIN = 'forge/device-consent/v1';

/**
 * `\n` is safe as a field separator without escaping: `userCode` has been
 * through `normalizeUserCode`, so it is `[A-Z0-9]*`, and `expiresAt` is
 * rendered from a number. Only `userId` is opaque, and it is last-but-one with
 * a fixed-shape field after it, so no reassignment of bytes across the
 * boundary can produce the same message from different inputs.
 */
function consentSignature(userCode: string, userId: string, expiresAt: number): string {
  return createHmac('sha256', env.BETTER_AUTH_SECRET)
    .update([CONSENT_TOKEN_DOMAIN, userCode, userId, String(expiresAt)].join('\n'))
    .digest('base64url');
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, so the lengths have to be
  // compared first. Nothing leaks: both sides are base64url SHA-256 digests of
  // a fixed length, so a mismatch here means malformed input, not a near-miss.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Mint the token step 2 will have to present. `userCode` is normalized by the
 * caller (`findDeviceRequest`), so the token is bound to the canonical code
 * rather than to whatever punctuation the human typed.
 */
export function issueDeviceConsentToken(
  userCode: string,
  userId: string,
  now: number = Date.now(),
): string {
  const expiresAt = now + CONSENT_TOKEN_TTL_MS;
  return `${expiresAt}.${consentSignature(userCode, userId, expiresAt)}`;
}

/**
 * True only for a token this server minted, for this code, for this user, that
 * has not expired.
 *
 * Every rejection is a plain `false` — the caller turns all of them into one
 * message, for the same reason `lookupDeviceAction` collapses its failures:
 * distinguishing "expired" from "wrong code" from "malformed" would make this
 * an oracle.
 */
export function verifyDeviceConsentToken(
  token: string,
  rawUserCode: string,
  userId: string,
  now: number = Date.now(),
): boolean {
  const separator = token.indexOf('.');
  if (separator <= 0) return false;

  const expiresAtRaw = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (signature.length === 0) return false;
  // Digits only. `Number('  12 ')` and `Number('0x10')` both parse, and a
  // token whose expiry round-trips differently to the one that was signed
  // would not verify anyway — but rejecting it here keeps the signed message
  // and the parsed value provably the same string.
  if (!/^\d+$/.test(expiresAtRaw)) return false;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAt)) return false;
  if (expiresAt <= now) return false;

  const userCode = normalizeUserCode(rawUserCode);
  return timingSafeEqualStrings(signature, consentSignature(userCode, userId, expiresAt));
}

/** What the consent page needs to describe the request to a human. */
export type DeviceRequestView = {
  userCode: string;
  clientId: string;
  scope: string | null;
  /**
   * Proof, to be handed back with the decision, that this browser completed
   * step 1 in this account. Not a credential for anything else: it grants no
   * access on its own and is useless without the session it was minted under.
   */
  consentToken: string;
};

export type DeviceDecision = 'approve' | 'deny';

export type DeviceDecisionOutcome =
  | { ok: true; decision: DeviceDecision; clientId: string }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'EXPIRED' | 'INVALID_CLIENT' | 'ALREADY_DECIDED' | 'INVALID_CONSENT';
      error: string;
    };

/**
 * Look up a still-decidable request by the code a human typed.
 *
 * Returns null — never a "the only pending one" fallback — when the code
 * doesn't resolve.
 *
 * Why that rule matters, stated accurately. Requiring the code does NOT prove
 * the person at this browser started the flow: whoever generated the code
 * knows it and can tell them (see the RFC 8628 §5.1 note in ./auth.ts). What
 * it does is keep the page from being the thing that supplies the code. A
 * lookup that fell back to "the only pending request" would let any signed-in
 * visitor approve an authorization they had never heard of, and would make the
 * page an enumeration oracle besides — so the strict lookup is load-bearing
 * even though the property it protects is narrower than "this request is
 * yours".
 *
 * There is deliberately no `if (userCode === '') return null` in front of the
 * query. It was written, and mutation testing killed nothing when it was
 * removed: `userCode` is NOT NULL and uniquely indexed and every generated
 * code is eight characters, so `eq(userCode, '')` cannot match a row. The
 * equality lookup IS the gate; an explicit guard in front of it would only
 * absorb mutations aimed at the lookup and make it look tested when it wasn't.
 */
export async function findDeviceRequest(
  rawUserCode: string,
  userId: string,
): Promise<DeviceRequestView | null> {
  const userCode = normalizeUserCode(rawUserCode);

  const [record] = await db
    .select()
    .from(deviceCode)
    .where(eq(deviceCode.userCode, userCode))
    .limit(1);

  if (!record) return null;
  if (record.status !== 'pending') return null;
  if (record.expiresAt <= Date.now()) return null;
  if (!record.clientId || !isAllowedDeviceClient(record.clientId)) return null;

  // Minted here and nowhere else: reaching this line IS "a human typed a code
  // that resolved to a live, pending, allow-listed request while signed in as
  // `userId`", which is exactly the fact step 2 needs to be able to check.
  return {
    userCode,
    clientId: record.clientId,
    scope: record.scope,
    consentToken: issueDeviceConsentToken(userCode, userId),
  };
}

/**
 * Approve or deny one device authorization — the only path in Forge that
 * writes `deviceCode.status`/`deviceCode.userId`, and therefore the only thing
 * that decides whose session `/device/token` will hand to the waiting CLI.
 *
 * `userId` is the caller's own identity, resolved by the transport (the
 * Server Action's `withAuth()`), exactly as `reviewTask` takes it — this
 * function never reads it from the request.
 *
 * The write is a compare-and-swap on `status = 'pending'`. That single
 * condition is the ownership guard, and it is deliberately the *only* one:
 *   - the first decision binds `userId` and moves the row out of `pending`;
 *   - every later decision, by anyone, matches zero rows and is refused,
 *     so a row bound to one user can never be rebound to another.
 * The plugin's own `if (record.userId && record.userId !== session.user.id)`
 * check is not a second line of defence here — it cannot fire on a fresh row,
 * whose `userId` is NULL, which is why `/device/approve` and `/device/deny`
 * are switched off in ./auth.ts and this is the sole implementation. Adding a
 * pre-read `status` check in front of the CAS would make the CAS untestable
 * (the pre-read would absorb every mutation), so the failure reason is
 * derived from the CAS matching nothing instead. The empty-code guard is
 * absent for the same reason — see `findDeviceRequest`.
 *
 * The consent-token check at the top is NOT a second ownership check and does
 * not stand in front of the CAS in that sense. It answers a different
 * question — "did this browser complete step 1, in this account, recently?" —
 * about a row that has no owner yet. Ownership is still decided by, and only
 * by, the CAS: the tests that pin first-decision-wins mint valid consent
 * tokens precisely so the token cannot absorb a mutation aimed at the CAS.
 */
export async function decideDeviceRequest(
  rawUserCode: string,
  userId: string,
  decision: DeviceDecision,
  consentToken: string,
): Promise<DeviceDecisionOutcome> {
  const userCode = normalizeUserCode(rawUserCode);

  // Before anything is read or written: this request must be the second half
  // of a lookup this server answered, for this code, in this account. See the
  // consent-token note above for why the two steps have to be tied together
  // server-side rather than by the form remembering it did step 1.
  if (!verifyDeviceConsentToken(consentToken, userCode, userId)) {
    return {
      ok: false,
      code: 'INVALID_CONSENT',
      error: 'that approval expired or did not come from this page — enter the code again',
    };
  }

  const [record] = await db
    .select()
    .from(deviceCode)
    .where(eq(deviceCode.userCode, userCode))
    .limit(1);

  if (!record) {
    return { ok: false, code: 'NOT_FOUND', error: 'that code was not recognised' };
  }
  if (record.expiresAt <= Date.now()) {
    return { ok: false, code: 'EXPIRED', error: 'that code has expired — start the sign-in again' };
  }
  if (!record.clientId || !isAllowedDeviceClient(record.clientId)) {
    return {
      ok: false,
      code: 'INVALID_CLIENT',
      error: 'that code was requested by an application this server does not recognise',
    };
  }

  const updated = await db
    .update(deviceCode)
    .set({ status: decision === 'approve' ? 'approved' : 'denied', userId })
    .where(and(eq(deviceCode.userCode, userCode), eq(deviceCode.status, 'pending')))
    .returning({ id: deviceCode.id });

  if (updated.length === 0) {
    return {
      ok: false,
      code: 'ALREADY_DECIDED',
      error: 'that code has already been approved or denied',
    };
  }

  return { ok: true, decision, clientId: record.clientId };
}
