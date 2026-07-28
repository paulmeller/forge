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
 * request" path — the point of asking for the code is that knowing it is the
 * evidence that the person at this browser is the person who started the flow
 * on the device.
 */
export async function lookupDeviceAction(formData: FormData): Promise<DeviceLookupState> {
  await withAuth();

  const typed = formData.get('userCode');
  if (typeof typed !== 'string' || typed.trim().length === 0) {
    return { error: 'Enter the code shown in your terminal.' };
  }

  const request = await findDeviceRequest(typed);
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
 * `decideDeviceRequest` (lib/device-auth.ts) does the rest; this wrapper is
 * only the FormData-to-arguments seam, mirroring `reviewAction`.
 */
export async function decideDeviceAction(formData: FormData): Promise<DeviceDecisionState> {
  const user = await withAuth();

  const userCode = formData.get('userCode');
  const op = formData.get('op');
  if (typeof userCode !== 'string' || userCode.trim().length === 0) {
    return { error: 'Enter the code shown in your terminal.' };
  }
  if (op !== 'approve' && op !== 'deny') {
    return { error: 'Choose whether to authorize or reject this device.' };
  }

  const outcome = await decideDeviceRequest(userCode, user.id, op);
  if (!outcome.ok) return { error: outcome.error };

  return { decided: outcome.decision, clientId: outcome.clientId };
}
