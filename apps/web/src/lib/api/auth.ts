import { apiAuth, type ApiUser } from '@/lib/api-auth';

/**
 * The single auth gate for /api/v1 routes.
 *
 * Centralising this is the point: auth was previously called per-route, which
 * is how apiAuth() and withAuth() drifted into different failure modes (fixed
 * 2026-07-27, commit 3536274). One wrapper means one place to reason about.
 *
 * Composes with middleware if the Node-runtime spike succeeded; stands alone
 * if it did not. Either way a route cannot forget the gate, because the
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
