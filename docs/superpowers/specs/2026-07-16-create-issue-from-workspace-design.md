# Create GitHub Issue from Repo Workspace — Design

Date: 2026-07-16
Status: approved (brainstorm complete)

## Thesis

Working an issue in Forge today always starts with an issue that already
exists on GitHub — the Repo Workspace only ever shows and acts on issues
fetched via GitHub search. This adds a fast path to file a brand-new issue
without leaving Forge. The created issue is a real GitHub issue (not a
Forge-only shadow record), and behaves exactly like any other synced issue
afterward: it shows up in the workspace list, and you click "Work on it"
whenever you're ready. Creating it does **not** auto-start work.

## UI

- A "+ New issue" button in the Repo Workspace header
  (`apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`), next to the
  existing "View mission" link.
- Opens a modal `Dialog`. No dialog/modal primitive exists yet in
  `apps/web/src/components/ui/` — add a thin wrapper over
  `@radix-ui/react-dialog` (new dependency; not currently installed —
  `@radix-ui/react-label` and `@radix-ui/react-select` are the closest
  existing precedent for wrapper style), following this UI kit's existing
  conventions (see `select.tsx`/`label.tsx`).
- Form fields, in a new client component (e.g. `new-issue-dialog.tsx`):
  - **Title** — required text input.
  - **Description** — optional `Textarea`.
  - **Labels** — optional text input, comma-separated (same parsing
    convention already used for repo lists in `RepoSelector`:
    `.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)`).
  - Submit / Cancel buttons.

## Server action

- New `createIssue(owner: string, repo: string, input: { title: string; body?: string; labels?: string[] })`
  added to `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`
  (same file as the existing `workOnIssue`).
- POSTs to `https://api.github.com/repos/{owner}/{repo}/issues` with
  `Authorization: Bearer ${env.GITHUB_APP_TOKEN}` — the same auth header
  the workspace page already uses for `githubSearchIssues`
  (`apps/web/src/lib/triage-planner.ts`). No new auth plumbing.
- Request body: `{ title, body, labels }` (GitHub's issue-creation API
  shape — `labels` as an array of label name strings).
- On success: dialog closes, client calls `router.refresh()` — matches the
  existing `WorkOnItButton` pattern. The new issue appears via the normal
  GitHub search on next load; it is **not** inserted into Forge's DB and
  no mission/task is created — "create only," per the approved design
  choice.
- Error handling:
  - Title-required is validated client-side before submit (matches the
    existing composer's inline field-error convention).
  - GitHub API errors (bad labels, rate limit, permission not yet
    granted, etc.) surface as an inline error message inside the dialog,
    not a toast — the dialog stays open so nothing typed is lost, and the
    user can retry or cancel.

## Permission change

- `apps/web/src/app/(app)/api/github/register/route.ts`: bump
  `default_permissions.issues` from `'read'` to `'write'`. This block is
  not branched on `isLocal`, so one edit covers both the local-dev and
  real-deployment manifest paths.
- Existing installations must accept the upgraded permission before
  `createIssue` will succeed against them — GitHub's own re-approval flow
  handles this; the exact prompt/step will be confirmed against the real
  GitHub UI during implementation/testing rather than assumed here.

## Data model

No schema changes. A created issue is never written to Forge's database —
it is purely a GitHub-side object that the existing search-based fetch
(`githubSearchIssues`) picks up on the next page load, identical to any
issue filed directly on GitHub. This keeps the feature's blast radius to
exactly two files touched by new logic (`actions.ts`, the new dialog
component) plus one new UI-kit primitive (`dialog.tsx`) plus the one-line
manifest permission bump.

## Known limitation (accepted, not solved this round)

GitHub's search index can lag a few seconds after issue creation, so an
immediate `router.refresh()` might not yet show the new issue in the list.
No optimistic UI insertion in this pass (YAGNI — keeps the diff small and
the behavior easy to reason about). If this proves annoying in practice,
optimistic insertion is a natural follow-up.

## Testing

- `createIssue`'s request-body construction and label-parsing are pure
  enough to unit test in isolation (given a title/body/labels input,
  produces the correct GitHub API request shape) — matches this project's
  convention of unit-testing pure helpers, not DB/network glue.
- The dialog's client-side required-title validation is a small enough
  piece of UI logic that it doesn't need a dedicated unit test, consistent
  with how the existing composer's simple field validations aren't
  separately unit-tested.
- Manual verification: open the dialog, submit with an empty title (see
  inline error, no request sent), submit a real title+body+labels against
  a real installation, confirm the issue appears in the repo's actual
  GitHub issue list and (after a refresh) in the Forge workspace list.

## Out of scope (deliberate)

- Auto-starting work on the newly created issue (rejected in favor of
  "create only, then decide").
- Optimistic UI insertion to work around GitHub search-index lag.
- Assignees, milestones, or any other GitHub issue field beyond
  title/body/labels.
- Editing or closing existing issues from Forge — this feature only adds
  creation.
