import { ZodError } from 'zod';

import { withApiAuth } from '@/lib/api/auth';
import { fail, notFound, ok } from '@/lib/api/respond';
import { schemas } from '@/lib/api/schemas';
import { db } from '@/lib/db';
import { getRepoPolicyForUser } from '@/lib/repo-policy';
import { findOwnedContainerByRepo, writeRepoPolicy } from '@/lib/repo-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ owner: string; repo: string }> };

export const GET = withApiAuth<Ctx>(async (user, _req, { params }) => {
  const { owner, repo: repoName } = await params;

  // findOwnedContainerByRepo is the SAME ownership gate the write below
  // uses — mirrors the interactive Settings page, which likewise only shows
  // (and reads) policy once a container mission exists for this user and
  // repo (repos/[owner]/[repo]/page.tsx). "No container" and "not yours"
  // both 404 identically; see lib/repo-settings.ts for the exact predicate.
  const found = await findOwnedContainerByRepo(user.id, `${owner}/${repoName}`);
  if (!found) return notFound('Repo');

  // getRepoPolicyForUser reads scoped by installations THIS user owns — the
  // read must be scoped the same way the write is, or one tenant's
  // installation can ungate another tenant's repo of the same name (see
  // that function's own doc comment). `found.workspaceRepo` — the row this
  // request's own ownership check just verified — is what's read, not the
  // raw path segments.
  const policy = await getRepoPolicyForUser(found.workspaceRepo!, user.id);
  return ok({ policy });
});

export const PUT = withApiAuth<Ctx>(async (user, req, { params }) => {
  const { owner, repo: repoName } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('invalid_request', 'Invalid JSON body', 400);
  }

  let requirePlanApproval: boolean;
  try {
    ({ requirePlanApproval } = schemas['repos.setPolicy'].body.parse(body));
  } catch (err) {
    if (err instanceof ZodError) {
      return fail('invalid_request', err.issues.map((i) => i.message).join('; '), 400);
    }
    throw err;
  }

  // The {owner}/{repo} path segments are used ONLY to look up a container
  // mission this caller owns. This is the sole ownership gate — do not add
  // a second, e.g. an additional userCanAccessRepo(user.id, repo) check
  // alongside it: that would be a second, independent check on the same
  // fact, and a break in findOwnedContainerByRepo's own scoping could hide
  // behind it exactly like the getMission-alongside-getTask case (found on
  // this branch, zero mutation failures). One gate, tested from both
  // directions (route.test.ts).
  //
  // The repo WRITTEN below is `found.workspaceRepo` — the row this lookup
  // returned — never `owner`/`repoName` from the URL. They are
  // byte-identical whenever `found` is non-null (the lookup's own repo-match
  // condition guarantees it), which is exactly why using the row instead of
  // the parameter is what makes the ownership check load-bearing rather than
  // decorative: it's the row, not string equality, that proves this
  // container is genuinely this user's own (hop two of the 2026-07-27
  // cross-account chain — see repo-settings.ts).
  const found = await findOwnedContainerByRepo(user.id, `${owner}/${repoName}`);
  if (!found) return notFound('Repo');

  const written = await db.transaction((tx) =>
    writeRepoPolicy(tx, user.id, found.workspaceRepo!, requirePlanApproval),
  );

  // Owning a container mission for this repo and holding an installation row
  // for it are two different facts (see writeRepoPolicy). They diverge once
  // the repo is dropped from the installation, or the App uninstalled, after
  // the container was created — and then the UPDATE above matches nothing.
  //
  // 404, not 409: 409 means "your request conflicts with the target
  // resource's current state", which promises there IS a resource and invites
  // a retry once the conflict clears. There is no conflicting row here —
  // there is no row at all. What the caller addressed, `{owner}/{repo}`'s
  // policy, does not exist for them, which is precisely 404. It also keeps
  // every failure of this endpoint on the one `not_found` code the CLI
  // already handles, and keeps absence indistinguishable from non-ownership
  // (this endpoint's GET/PUT 404 identically for "not yours").
  //
  // What must NOT happen is the previous behaviour: an unconditional
  // `ok({ requirePlanApproval })` asserting a value that was never persisted.
  // An operator turning approval ON, being told it succeeded, and having the
  // stored row still say `false` means agents keep dispatching unapproved.
  if (written === 0) return notFound('Repo policy');

  return ok({ policy: { requirePlanApproval } });
});
