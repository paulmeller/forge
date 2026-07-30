/**
 * Same-origin enforcement for cookie-authenticated **route handlers**.
 *
 * Next's Server Action origin check does not cover route handlers, so a
 * `POST /api/...` reached from another site still arrives with the user's
 * session cookie attached and looks fully authenticated. For a handler that
 * can take actions on the user's behalf — creating missions, spending LLM
 * budget — a valid cookie alone is not sufficient evidence that the user
 * intended the request.
 *
 * Two independent checks, both cheap, both before any body parsing:
 *
 *  - **Content-Type must be JSON.** The content types a cross-site form can
 *    send without triggering a CORS preflight are `text/plain`,
 *    `application/x-www-form-urlencoded` and `multipart/form-data`. Requiring
 *    `application/json` forces a preflight, which the browser will not pass
 *    without explicit CORS headers this app never sends.
 *  - **The request must prove same-origin.** `Sec-Fetch-Site` is the direct
 *    signal where the browser sends it; `Origin` compared against the host is
 *    the fallback. Absence of both is a rejection, not a pass — this endpoint
 *    is browser-facing, and every browser that can reach it sends at least one.
 *
 * Returns a reason string when the request should be rejected, or null when it
 * is acceptable. Pure, so the policy is testable without a server.
 */
export type OriginCheckInput = {
  contentType: string | null;
  origin: string | null;
  secFetchSite: string | null;
  host: string | null;
  /**
   * `x-forwarded-proto`. Cloud Run terminates TLS, so the inbound request is
   * http while the browser's Origin says https — comparing without this would
   * reject every legitimate production request.
   */
  forwardedProto?: string | null;
};

export function rejectCrossSite(input: OriginCheckInput): string | null {
  const mediaType = (input.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return `unsupported content-type: ${mediaType || '(none)'}`;
  }

  // Sec-Fetch-Site is the browser's own account of the relationship and cannot
  // be set by page script, so it is preferred where present. `same-site` is
  // deliberately rejected alongside `cross-site`: a sibling subdomain is not
  // this origin, and this app does not delegate authority to one.
  if (input.secFetchSite) {
    return input.secFetchSite === 'same-origin'
      ? null
      : `cross-site request rejected (sec-fetch-site: ${input.secFetchSite})`;
  }

  if (input.origin) {
    if (!input.host) return 'cannot verify origin: no host header';
    const proto = input.forwardedProto || 'https';
    const expected = `${proto}://${input.host}`.toLowerCase();
    return input.origin.toLowerCase() === expected
      ? null
      : `cross-site request rejected (origin ${input.origin} != ${expected})`;
  }

  return 'cross-site request rejected (no origin or sec-fetch-site header)';
}
