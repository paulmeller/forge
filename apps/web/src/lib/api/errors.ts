import type { MissionTransitionError } from '@/lib/mission-transitions';
import type { PlannerError } from '@/lib/planner';

/**
 * THE closed set of `error.code` values any /api/v1 response may carry.
 *
 * Before this existed the API spoke three vocabularies at once: respond.ts's
 * lowercase snake (`not_found`, `invalid_request`, …), the mission lifecycle
 * routes forwarding `MissionTransitionError.code` raw (`NOT_FOUND`,
 * `WRONG_STATUS`), and plan/route.ts forwarding `PlannerError.code`
 * (`MISSION_NOT_FOUND`, `WRONG_STATUS`, `NO_TARGET_REPOS`,
 * `ALREADY_PLANNED`). Handling "not found" meant matching three strings;
 * handling a 409 meant matching four.
 *
 * Lowercase snake won because it was already the majority (every respond.ts
 * emission plus the 401 from api-auth.ts), so adopting it renames the fewest
 * codes a client would see.
 *
 * The list is deliberately short and status-shaped: one code per HTTP
 * condition a caller must branch on, not one per internal cause. `fail()`
 * takes `ApiErrorCode`, not `string`, so a route physically cannot invent a
 * seventh code or forward an internal one — the mapping below is the only
 * way an internal error reaches the wire, and the compiler enforces it.
 * `docs/api/openapi.json` enumerates this same array in
 * `components.schemas.Error`, generated from it, so the set is discoverable
 * without reading source.
 */
export const apiErrorCodes = [
  /** Malformed JSON, or a body/query that failed schema validation. 400. */
  'invalid_request',
  /** No usable credential, or one that no longer resolves to a user. 401. */
  'unauthorized',
  /** Authenticated, but not permitted to act on a named resource. 403. */
  'forbidden',
  /**
   * The addressed resource does not exist *for this caller*. Deliberately
   * indistinguishable from "exists but belongs to someone else" — see
   * notFound() in respond.ts. 404.
   */
  'not_found',
  /**
   * The request is well formed and permitted, but conflicts with the
   * resource's current state (wrong status for the transition, nothing to
   * plan, already planned). 409.
   */
  'invalid_state',
  /** A backend/adapter the request depends on failed. Retryable. 502. */
  'bad_gateway',
] as const;

export type ApiErrorCode = (typeof apiErrorCodes)[number];

/** What `fail()` needs to emit a mapped internal error. */
export type ApiFailure = { code: ApiErrorCode; message: string; status: number };

/**
 * Internal domain codes -> transport codes.
 *
 * `Record<Internal, …>` rather than a switch with a default: adding a code to
 * MissionTransitionError or PlannerError then fails to compile here, instead
 * of silently falling through to some catch-all the CLI cannot interpret.
 *
 * MissionTransitionError and PlannerError are unchanged — they are domain
 * errors, the Server Action path and the tick engine read them, and their
 * codes carry distinctions (ALREADY_PLANNED vs NO_TARGET_REPOS) that matter
 * inside the app. The collapse to one transport code happens here, at the
 * edge, and only for the wire.
 */
const MISSION_TRANSITION_CODES: Record<
  MissionTransitionError['code'],
  { code: ApiErrorCode; status: number }
> = {
  NOT_FOUND: { code: 'not_found', status: 404 },
  WRONG_STATUS: { code: 'invalid_state', status: 409 },
};

const PLANNER_CODES: Record<PlannerError['code'], { code: ApiErrorCode; status: number }> = {
  MISSION_NOT_FOUND: { code: 'not_found', status: 404 },
  WRONG_STATUS: { code: 'invalid_state', status: 409 },
  NO_TARGET_REPOS: { code: 'invalid_state', status: 409 },
  ALREADY_PLANNED: { code: 'invalid_state', status: 409 },
};

/**
 * Three planner causes collapse onto one `invalid_state` code, so the cause
 * has to survive in the message or the caller loses information the old raw
 * forwarding gave it. The domain messages already say it in words —
 * "mission has no target repos", "mission is planning; planner only runs on
 * draft" — and that is what a CLI prints to a human anyway. Nothing is
 * appended: prefixing the internal code back onto the message would
 * reintroduce the second vocabulary this exists to remove, one string
 * concatenation later.
 */
export function plannerFailure(err: PlannerError): ApiFailure {
  const { code, status } = PLANNER_CODES[err.code];
  return { code, message: err.message, status };
}

/** Same contract as plannerFailure, for the mission lifecycle transitions. */
export function missionTransitionFailure(err: MissionTransitionError): ApiFailure {
  const { code, status } = MISSION_TRANSITION_CODES[err.code];
  return { code, message: err.message, status };
}
