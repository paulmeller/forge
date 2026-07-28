/** One success shape and one error shape across every v1 route. */
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
