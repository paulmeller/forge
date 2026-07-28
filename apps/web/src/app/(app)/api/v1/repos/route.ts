import { withApiAuth } from '@/lib/api/auth';
import { ok } from '@/lib/api/respond';
import { listUserRepos } from '@/lib/mission-defaults-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Scoped through the caller's own installations — the same notion
// userCanAccessRepo (mission-defaults-db.ts) uses to gate every entry point
// that takes a caller-supplied repo string, reusing listUserRepos's identical
// join (github_installation_repos -> github_installations, filtered to this
// user) rather than inventing a second "does the user have this repo" query
// shape that could quietly drift from it.
export const GET = withApiAuth(async (user) => {
  return ok({ repos: await listUserRepos(user.id) });
});
