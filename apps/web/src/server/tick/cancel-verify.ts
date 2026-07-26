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
    return session.status === 'terminated';
  } catch {
    return false;
  }
}
