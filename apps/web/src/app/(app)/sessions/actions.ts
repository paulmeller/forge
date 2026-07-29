'use server';

import { revalidatePath } from 'next/cache';

import { revokeSessionById } from '@/lib/sessions';
import { withAuth } from '@/lib/with-auth';

export type RevokeSessionState = { error?: string; ok?: boolean };

/**
 * Thin transport over `revokeSessionById` (lib/sessions.ts) — which session is
 * revocable, and by whom, is decided there. This wrapper pulls the id out of
 * FormData, requires a signed-in caller, and revalidates the list.
 *
 * `withAuth()` is here for the redirect-to-login behaviour, not as the
 * authorization: the lib call resolves the id inside the caller's own session
 * list and better-auth's `/revoke-session` checks the owner again on its side.
 */
export async function revokeSessionAction(formData: FormData): Promise<RevokeSessionState> {
  await withAuth();

  const sessionId = formData.get('sessionId');
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { error: 'Choose a session to sign out.' };
  }

  const outcome = await revokeSessionById(sessionId);
  if (!outcome.ok) return { error: outcome.error };

  revalidatePath('/sessions');
  return { ok: true };
}
