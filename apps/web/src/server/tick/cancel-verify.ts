import type { GetSessionResult } from './adapters';

type SessionReader = {
  getSession(sessionId: string, backendSessionRef?: string | null): Promise<GetSessionResult>;
};

/**
 * Reads a session's status back after a cancel to confirm it actually stopped.
 *
 * Cancelling an already-finished backend session returns HTTP 200 and throws
 * nothing, so a try/catch around cancelSession cannot detect that the wrong
 * session was targeted. Reading the status back can.
 *
 * Success is "the agent is no longer burning budget", not "the session object
 * is literally terminated". `managed-agents` and `gateway` both implement
 * cancelSession by sending a `user.interrupt` event, which drains the session
 * to `idle` at the next safe boundary — it does NOT terminate it (see
 * docs/ma-api-audit.md:27 and docs/superpowers/specs/2026-06-08-loop-guardrails-design.md:466-468).
 * Only the Gemini adapter's cancel actually yields `terminated`. So `idle` must
 * count as a verified cancel; only `running`/`rescheduling` (still active) counts
 * as unverified.
 *
 * Known limitation (not a bug): because the interrupt drain is asynchronous, an
 * immediate read-back can legitimately observe `running` before the drain
 * completes, producing an occasional false "unverified" on an otherwise-successful
 * cancel. That's acceptable — it errs toward over-reporting rather than
 * under-reporting a still-live session.
 *
 * Never throws: a failed status read means "unverified", not "still running",
 * and must not disturb the caller's best-effort cancel contract.
 */
export async function verifyCancelled(
  adapter: SessionReader,
  sessionId: string,
  backendSessionRef?: string | null,
): Promise<boolean> {
  try {
    const session = await adapter.getSession(sessionId, backendSessionRef);
    return session.status !== 'running' && session.status !== 'rescheduling';
  } catch {
    return false;
  }
}
