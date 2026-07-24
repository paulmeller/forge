# /setup Page Redesign — Design

## Motivation

`/setup` (`apps/web/src/app/(app)/setup/page.tsx`) is a 3-screen wizard (install GitHub App → free-text repo entry → "you're all set"), styled narrow and centered (`max-w-lg px-6 py-20`) — visually inconsistent with the rest of the app's now-standard wide `PageShell`/`PageHeader` layout (`/home`, `/missions`, `/repos`), and functionally limited: the repo-selection step is a raw textarea where you type `owner/repo` strings by hand, validated only by a client-side regex, with no verification the installation actually has access to what you typed, and no way to ever remove a connected repo.

Explored via the visual companion (two mockups: a restyled version of today's 3-separate-screens stepper, vs. a single-page checklist showing all steps at once). The user picked the single-page checklist, then confirmed the repo picker should be a real, bidirectionally-syncing GitHub-backed checkbox list rather than free text.

## Scope

- Redesign `apps/web/src/app/(app)/setup/page.tsx` as a single page with three checklist items (Install → Select repos → Try it), each showing its own done/active/locked state, instead of three separate screens.
- Replace the free-text `RepoSelector` (`./repo-selector.tsx`) with a real checkbox picker fetching the installation's actual accessible repos live from GitHub.
- Replace the insert-only `connectRepos` server action (`./actions.ts`) with a new `syncRepos` action supporting both connecting and disconnecting repos.
- Full-width `PageShell`/`PageHeader`, matching `/home`/`/missions`/`/repos`.
- No changes to `github-installation-sync.ts`, `github-app-auth.ts`, or the GitHub App installation flow itself (the "Install Forge on GitHub" link/redirect is unchanged).
- Disconnecting a repo only removes its `githubInstallationRepos` row — no effect on existing missions/tasks for that repo, no blocking/warning based on active missions.

## Page Structure

One page, three items, each computed from the same page-load data fetch:

```tsx
export default async function SetupPage() {
  const user = await withAuth();
  const [installation] = await db.select().from(githubInstallations).where(eq(githubInstallations.userId, user.id));

  let ghRepos: string[] | null = null; // null = not fetched (no installation, or fetch failed)
  let connectedRepos: string[] = [];
  if (installation) {
    connectedRepos = (await db.select().from(githubInstallationRepos).where(eq(githubInstallationRepos.installationId, installation.id))).map(r => r.repo);
    // Same env vars and guard github-installation-sync.ts:31-34 already uses —
    // reused, not reintroduced.
    if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
      try {
        const token = await createInstallationAccessToken(installation.installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
        ghRepos = await listInstallationRepositories(token);
      } catch {
        ghRepos = null; // fall back to DB-known repos only, see Edge Cases
      }
    }
  }

  return (
    <PageShell>
      <PageHeader title="Get set up" subtitle="Connect GitHub and choose which repos Forge can work on." />
      {/* Item 1 (Install) and Item 3 (Try it) are static server-rendered content —
          no interactivity, no reason to extract them into their own files; they
          stay as inline JSX blocks in page.tsx. Only Item 2's picker needs to be
          a separate component, since it's the one piece requiring client-side
          state (checkbox toggling before the Save button submits). */}
      {/* Item 1 inline here */}
      <RepoPicker installation={installation} ghRepos={ghRepos} connectedRepos={connectedRepos} />
      {/* Item 3 inline here */}
    </PageShell>
  );
}
```

**Item 1 (Install):** if no `installation`, renders the install button (same GitHub App install link as today, unchanged). If `installation` exists, renders as done — a check mark, plus the installation's account login (`installation.accountLogin`) — no action needed.

**Item 2 (Select repos):** rendered in a visually "locked" state (dimmed, no interactive content) when `!installation`. Once unlocked, renders `RepoPicker` (new client component, replacing `RepoSelector`): a checkbox per repo in `ghRepos` (or, if `ghRepos === null` because the live fetch failed, just `connectedRepos` with no ability to add new ones — see Edge Cases), pre-checked for anything in `connectedRepos`, plus a "Save selection" button that calls the new `syncRepos` action with the full checked-state array.

**Item 3 (Try it):** locked when `connectedRepoCount === 0`. Once unlocked, shows the "comment `@forge` on any issue" hint (the same copy as today's old "all set" screen), plus a link into `/missions` or `/missions/new`.

## `syncRepos` Server Action

Replaces `connectRepos` in `apps/web/src/app/(app)/setup/actions.ts`:

```ts
export async function syncRepos(installationId: string, selectedRepos: string[]): Promise<{ error?: string } | undefined> {
  const user = await withAuth();
  const [installation] = await db.select().from(githubInstallations).where(eq(githubInstallations.id, installationId)).limit(1);
  if (!installation || installation.userId !== user.id) return { error: 'Installation not found' };

  const existing = await db.select().from(githubInstallationRepos).where(eq(githubInstallationRepos.installationId, installationId));
  const existingRepoNames = new Set(existing.map(r => r.repo));
  const selectedSet = new Set(selectedRepos);

  const toAdd = selectedRepos.filter(r => !existingRepoNames.has(r));
  const toRemove = existing.filter(r => !selectedSet.has(r.repo));

  for (const repo of toAdd) {
    const id = `ghr_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await db.insert(githubInstallationRepos).values({ id, installationId, repo }).onConflictDoNothing();
  }
  for (const row of toRemove) {
    await db.delete(githubInstallationRepos).where(eq(githubInstallationRepos.id, row.id));
  }

  return undefined;
}
```

This is a diff-and-sync operation (compute what to add and what to remove by comparing the submitted checked-state against the current DB state), not a destructive "delete everything then reinsert" — existing rows for repos that stay checked are left untouched.

## Edge Cases

- **GitHub API call to list the installation's repos fails** (network error, revoked token, etc.): the page falls back to rendering only `connectedRepos` (what's already in the DB) as checked, read-only — no checkboxes for repos not already connected, since we don't know what else the installation can see. A small inline note explains new repos can't be added right now, try again shortly.
- **Disconnecting a repo with active missions**: allowed with no warning — this only affects future dispatch eligibility (whether the repo shows up as connectable), not any existing mission/task history for that repo.
- **Zero repos available at all** (installation exists but has access to nothing, or a GitHub API scope issue): the picker shows an empty state, not an error — "No repos available. Check the GitHub App's repository access settings."
- **Multiple GitHub App installations for one user**: out of scope, unchanged from today — the page still only ever reads `installations[0]`.

## Testing

- `syncRepos`'s add/remove diffing logic is the one new piece of business logic worth a real test (mocking the DB, following this app's established mocking conventions for server actions/DB-touching functions) — covering: adding only, removing only, a mix of both, and the no-op case (selected set exactly matches existing).
- No changes needed to any `github-app-auth.ts`/`github-installation-sync.ts` test coverage — both are reused unchanged.
- No test coverage for the page component itself or `RepoPicker` (consistent with this app's established pattern of not unit-testing page/rendering components).

## Explicitly Out of Scope

- Any change to the GitHub App installation flow itself (install button, redirect-back behavior).
- Multiple installations per user.
- Blocking or warning when disconnecting a repo with active missions.
- `github-installation-sync.ts`/`github-app-auth.ts` — reused as-is, not modified.
