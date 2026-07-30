/**
 * The one statement Forge makes to an agent about where the repository is.
 *
 * It deliberately asserts no path. The same `managed-agents` backend can point
 * at hosted Managed Agents (repo mounted under `/mnt/session/resources/`) or at
 * a self-hosted sandbox (repo cloned to the session workspace, which is the
 * agent's working directory), and Forge cannot tell which from the backend name
 * alone — it is a function of the base URL the operator configured. Any fixed
 * path is therefore wrong roughly half the time.
 *
 * #65: three prompt sites each hardcoded the hosted layout. Against a
 * self-hosted sandbox the agent's opening command failed and it spent turns
 * running `find /` to locate the checkout before recovering. Those turns count
 * against `max_turns` and the no-progress guardrail, and self-recovery hides the
 * cause — it reads as a slow agent rather than a harness asserting something
 * untrue.
 *
 * Telling the agent how to *resolve* the path beats telling it a path: the
 * command below is correct on every layout, now and after the next one.
 */
export const REPO_LOCATION_HINT =
  'The repository is already checked out. It is normally your working directory; ' +
  'if it is not, run `git rev-parse --show-toplevel` to locate it. ' +
  'Do not assume a fixed absolute path.';
