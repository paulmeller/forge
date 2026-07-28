export const config = { matcher: '/api/v1/:path*', runtime: 'nodejs' };

export function middleware() {
  // Spike only — proving the Node runtime is available to middleware.
  return undefined;
}
