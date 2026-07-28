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

/** What the consent page needs to describe the request to a human. */
export type DeviceRequestView = {
  userCode: string;
  clientId: string;
  scope: string | null;
};

export type DeviceDecision = 'approve' | 'deny';

export type DeviceDecisionOutcome =
  | { ok: true; decision: DeviceDecision; clientId: string }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'EXPIRED' | 'INVALID_CLIENT' | 'ALREADY_DECIDED';
      error: string;
    };

/**
 * Look up a still-decidable request by the code a human typed.
 *
 * Returns null — never a "the only pending one" fallback — when the code
 * doesn't resolve. The whole security property of this page is that the person
 * approving had to know the code, so a lookup that succeeds without the right
 * code would give the exploit back for free.
 *
 * There is deliberately no `if (userCode === '') return null` in front of the
 * query. It was written, and mutation testing killed nothing when it was
 * removed: `userCode` is NOT NULL and uniquely indexed and every generated
 * code is eight characters, so `eq(userCode, '')` cannot match a row. The
 * equality lookup IS the gate; an explicit guard in front of it would only
 * absorb mutations aimed at the lookup and make it look tested when it wasn't.
 */
export async function findDeviceRequest(rawUserCode: string): Promise<DeviceRequestView | null> {
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

  return { userCode, clientId: record.clientId, scope: record.scope };
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
 */
export async function decideDeviceRequest(
  rawUserCode: string,
  userId: string,
  decision: DeviceDecision,
): Promise<DeviceDecisionOutcome> {
  const userCode = normalizeUserCode(rawUserCode);

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
