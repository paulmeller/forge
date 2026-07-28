/**
 * One success shape and one error shape across every v1 route.
 *
 * THE ENVELOPE CONVENTION — every 2xx body is a JSON **object** whose payload
 * sits under a key named for the resource:
 *
 *   - a single resource  -> `{ mission: {...} }`, `{ task: {...} }`,
 *                           `{ policy: {...} }`
 *   - a collection       -> `{ missions: [...] }`, `{ tasks: [...] }`,
 *                           `{ events: [...] }`, `{ repos: [...] }`
 *   - extra metadata     -> a sibling key next to the resource, never a
 *                           different shape: `{ mission, taskCount, skipped }`,
 *                           `{ mission, retriedCount }`
 *
 * Two properties make this worth the breaking change, and both are lost by
 * the "bare single resource, wrapped collection" variant this replaced:
 *
 *  1. A CLI writes ONE response handler. `POST /missions/{id}/start` and
 *     `POST /missions/{id}/retry` both put the mission at `body.mission`;
 *     the caller reads one field regardless of whether the operation also
 *     reports a count. Returning `start` bare and `retry` wrapped made the
 *     envelope depend on whether an operation happened to have metadata —
 *     an implementation detail the caller cannot predict from the URL.
 *  2. Every response can grow. A bare array (`GET /missions` used to return
 *     one) has nowhere to put pagination, and a bare object collides with
 *     any future sibling field. Adding `nextCursor` beside `missions` is
 *     additive; adding it to a bare array is a new major version.
 *
 * The cost is one extra dereference (`body.mission` rather than `body`) on
 * every call, paid uniformly. That is the trade accepted here.
 */
export function ok<T>(data: T, status = 200): Response {
  return Response.json(data, { status });
}

export function fail(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Ownership failures use 404, never 403 — a resource's existence must not be
 * observable across accounts. getMission/getTask already return null for both
 * "does not exist" and "not yours", so this keeps the API consistent with the
 * data layer rather than leaking the distinction.
 */
export function notFound(what: string): Response {
  return fail('not_found', `${what} not found`, 404);
}
