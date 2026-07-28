import { apiAuth, type ApiUser } from '@/lib/api-auth';

/**
 * The single auth gate for /api/v1 routes.
 *
 * Centralising this is the point: auth was previously called per-route, which
 * is how apiAuth() and withAuth() drifted into different failure modes (fixed
 * 2026-07-27, commit 3536274). One wrapper means one place to reason about.
 *
 * This wrapper is the whole gate — there is no middleware layer. The spike
 * that proposed one established only that Next accepts `runtime: 'nodejs'`
 * in a middleware config at build time; it never proved a DB-backed session
 * lookup executes there at request time, and Next 16 has begun deprecating
 * the `middleware` convention in favour of `proxy`. Centralisation is worth
 * having, but not at the cost of a layer that is half-verified and already
 * on its way out. A route cannot forget the gate regardless, because the
 * wrapper is what produces the exported handler.
 */
export function withApiAuth<T>(
  handler: (user: ApiUser, req: Request, ctx: T) => Promise<Response>,
): (req: Request, ctx: T) => Promise<Response> {
  return async (req, ctx) => {
    const [user, rejection] = await apiAuth();
    if (rejection) return rejection;
    return handler(user, req, ctx);
  };
}
