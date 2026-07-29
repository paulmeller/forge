'use server';

import {
  decideDeviceRequest,
  findDeviceRequest,
  type DeviceDecision,
  type DeviceRequestView,
} from '@/lib/device-auth';
import { withAuth } from '@/lib/with-auth';

export type DeviceLookupState = { error?: string; request?: DeviceRequestView };
export type DeviceDecisionState = { error?: string; decided?: DeviceDecision; clientId?: string };

/**
 * Step one of the consent page: turn a code a human typed into the request it
 * names, so the page can say which client is asking before anything is
 * granted.
 *
 * Deliberately does nothing without a code. There is no "show me the pending
 * request" path, so a crafted link cannot land someone on a pre-filled consent
 * screen one click from approving. Note what that does NOT establish: knowing
 * the code is not evidence that this person started the flow, because whoever
 * started it chose the code and can simply pass it on. Typing defeats the
 * one-click variant, not social engineering — see lib/auth.ts.
 *
 * This lookup is itself an authenticated oracle: a caller who guesses a live
 * code learns its client. Server Actions post to the page route, so neither
 * better-auth's limiter nor guardRateLimitEvasion covers this path. 32^8 codes
 * over a 5-minute window makes that impractical rather than prevented.
 */
export async function lookupDeviceAction(formData: FormData): Promise<DeviceLookupState> {
  const user = await withAuth();

  const typed = formData.get('userCode');
  if (typeof typed !== 'string' || typed.trim().length === 0) {
    return { error: 'Enter the code shown in your terminal.' };
  }

  const request = await findDeviceRequest(typed, user.id);
  if (!request) {
    // One message for unknown, expired, already-decided and unrecognised-client.
    // Splitting them would turn this form into an oracle for guessing codes.
    return { error: "That code isn't valid. Check it and try again, or start the sign-in over." };
  }

  return { request };
}

/**
 * Step two: approve or deny the request the human just identified.
 *
 * `withAuth()` is the only source of the approving identity — never the form.
 * The `consentToken` IS read from the form, and that is fine: it is an HMAC
 * this server minted in step one over `(userCode, userId, expiry)`, so a value
 * the submitter chose cannot verify. `decideDeviceRequest`
 * (lib/device-auth.ts) checks it; this wrapper is only the
 * FormData-to-arguments seam, mirroring `reviewAction`.
 *
 * Note what this closes. Without the token, a single request carrying
 * `{userCode, op: 'approve'}` and a valid session cookie was a completed
 * approval — the server had no way to tell it apart from one that had been
 * through the lookup, and "the human typed it in step 1" was purely a
 * client-side story. `sameSite: 'lax'` and Next's Server Action origin check
 * held it shut, but Next permits an action request with no Origin header at
 * all, so the only durable answer is for step 2 to carry proof of step 1.
 */
export async function decideDeviceAction(formData: FormData): Promise<DeviceDecisionState> {
  const user = await withAuth();

  const userCode = formData.get('userCode');
  const op = formData.get('op');
  const consentToken = formData.get('consentToken');
  if (typeof userCode !== 'string' || userCode.trim().length === 0) {
    return { error: 'Enter the code shown in your terminal.' };
  }
  if (op !== 'approve' && op !== 'deny') {
    return { error: 'Choose whether to authorize or reject this device.' };
  }
  if (typeof consentToken !== 'string' || consentToken.length === 0) {
    // Same message the token check itself produces: a submission with no token
    // and one with a bad token are the same event — something that did not
    // come from step one of this page.
    return { error: 'That approval expired or did not come from this page. Enter the code again.' };
  }

  const outcome = await decideDeviceRequest(userCode, user.id, op, consentToken);
  if (!outcome.ok) return { error: outcome.error };

  return { decided: outcome.decision, clientId: outcome.clientId };
}
