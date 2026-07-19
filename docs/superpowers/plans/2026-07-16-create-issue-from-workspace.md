# Create GitHub Issue from Repo Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user file a brand-new GitHub issue directly from the Repo Workspace, via a modal dialog, without leaving Forge. The created issue is a real GitHub issue — it shows up in the workspace's normal issue list on next load and behaves like any other synced issue ("Work on it" is a separate, later action).

**Architecture:** A pure helper module (`github-issue-create.ts`) validates/shapes the create-issue payload. A new server action (`createIssue`, alongside the existing `workOnIssue`) POSTs that payload to GitHub's REST API using the same static app-token auth the workspace page already uses for issue search. A new generic `Dialog` UI primitive (this kit doesn't have one yet) hosts a feature-specific `NewIssueDialog` client component, wired into the Repo Workspace header. A one-line manifest permission bump (`issues: 'read'` → `'write'`) is required for the GitHub App to be allowed to create issues at all.

**Tech Stack:** Next.js 15 App Router (server actions), React 19, Radix UI, vitest.

## Global Constraints

- No schema changes. A created issue is never written to Forge's database — it's picked up by the existing `githubSearchIssues` call on next page load, exactly like any issue filed directly on GitHub.
- Creating an issue does **not** auto-start work. No mission/task is created by this feature — only `workOnIssue` (existing, untouched) does that.
- Auth: reuse `env.GITHUB_APP_TOKEN` with the exact header shape already used by `githubSearchIssues` in `apps/web/src/lib/triage-planner.ts` (`Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`). Do not introduce the separate installation-token JWT flow (`github-app-auth.ts`) for this feature — it's unrelated auth machinery for a different purpose.
- The `apps/web/src/components/ui/` folder's existing primitives (`select.tsx`, `label.tsx`, `input.tsx`, `textarea.tsx`, `button.tsx`) use no-semicolon, double-quote style (shadcn's generated convention) — this differs from the rest of the app, which uses semicolons/single-quotes. Match the local `ui/` folder convention in the new `dialog.tsx`, not the app-wide style.
- Run all commands from the repo root `/Users/paulmeller/Projects/agentstep/agentstep-forge`.
- Spec: `docs/superpowers/specs/2026-07-16-create-issue-from-workspace-design.md`.

---

### Task 1: `github-issue-create.ts` — pure label-parsing and payload helpers (TDD)

**Files:**
- Create: `apps/web/src/lib/github-issue-create.ts`
- Test: `apps/web/src/lib/github-issue-create.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function parseLabelsInput(raw: string): string[];
  type CreateIssueInput = { title: string; body?: string; labels?: string[] };
  type CreateIssuePayload = { title: string; body?: string; labels?: string[] };
  function buildCreateIssuePayload(input: CreateIssueInput): CreateIssuePayload;
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/github-issue-create.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { buildCreateIssuePayload, parseLabelsInput } from './github-issue-create';

describe('parseLabelsInput', () => {
  it('splits comma-separated labels and trims whitespace', () => {
    expect(parseLabelsInput('bug, p1,  needs-repro')).toEqual(['bug', 'p1', 'needs-repro']);
  });

  it('splits newline-separated labels', () => {
    expect(parseLabelsInput('bug\np1\nneeds-repro')).toEqual(['bug', 'p1', 'needs-repro']);
  });

  it('handles mixed commas and newlines', () => {
    expect(parseLabelsInput('bug,\np1, needs-repro')).toEqual(['bug', 'p1', 'needs-repro']);
  });

  it('filters out empty segments from trailing/duplicate separators', () => {
    expect(parseLabelsInput('bug,, p1,')).toEqual(['bug', 'p1']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseLabelsInput('')).toEqual([]);
    expect(parseLabelsInput('   ')).toEqual([]);
  });
});

describe('buildCreateIssuePayload', () => {
  it('trims the title', () => {
    expect(buildCreateIssuePayload({ title: '  Fix the thing  ' })).toEqual({
      title: 'Fix the thing',
    });
  });

  it('omits body when empty or whitespace-only', () => {
    expect(buildCreateIssuePayload({ title: 'x', body: '' })).toEqual({ title: 'x' });
    expect(buildCreateIssuePayload({ title: 'x', body: '   ' })).toEqual({ title: 'x' });
  });

  it('trims and includes body when present', () => {
    expect(buildCreateIssuePayload({ title: 'x', body: '  details  ' })).toEqual({
      title: 'x',
      body: 'details',
    });
  });

  it('omits labels when the array is empty or absent', () => {
    expect(buildCreateIssuePayload({ title: 'x', labels: [] })).toEqual({ title: 'x' });
    expect(buildCreateIssuePayload({ title: 'x' })).toEqual({ title: 'x' });
  });

  it('includes labels when present, dropping empty strings', () => {
    expect(buildCreateIssuePayload({ title: 'x', labels: ['bug', '', 'p1'] })).toEqual({
      title: 'x',
      labels: ['bug', 'p1'],
    });
  });

  it('includes title, body, and labels together', () => {
    expect(
      buildCreateIssuePayload({ title: ' x ', body: ' y ', labels: ['bug'] }),
    ).toEqual({ title: 'x', body: 'y', labels: ['bug'] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/web test -- github-issue-create`
Expected: FAIL — cannot resolve `./github-issue-create`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/github-issue-create.ts`:

```ts
/** Same comma/newline-separated parsing convention used by RepoSelector for repo lists. */
export function parseLabelsInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type CreateIssueInput = { title: string; body?: string; labels?: string[] };
export type CreateIssuePayload = { title: string; body?: string; labels?: string[] };

/** Shapes a GitHub issue-creation request body, trimming and dropping empty optional fields. */
export function buildCreateIssuePayload(input: CreateIssueInput): CreateIssuePayload {
  const title = input.title.trim();
  const body = input.body?.trim();
  const labels = (input.labels ?? []).map((l) => l.trim()).filter(Boolean);

  const payload: CreateIssuePayload = { title };
  if (body) payload.body = body;
  if (labels.length > 0) payload.labels = labels;
  return payload;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @forge/web test -- github-issue-create`
Expected: PASS (12 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/github-issue-create.ts apps/web/src/lib/github-issue-create.test.ts
git commit -m "feat(workspace): pure label-parsing and payload helpers for issue creation"
```

---

### Task 2: `createIssue` server action

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`

**Interfaces:**
- Consumes: `buildCreateIssuePayload` (Task 1), `env.GITHUB_APP_TOKEN` (existing, `@/lib/env`), `withAuth` (existing, already imported in this file).
- Produces:
  ```ts
  function createIssue(
    owner: string,
    repo: string,
    input: { title: string; body?: string; labels?: string[] },
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  ```

- [ ] **Step 1: Add the action**

The current file (`apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`) starts with `'use server';` and imports `withAuth` from `@/lib/with-auth` already. Add these two imports:

```ts
import { env } from '@/lib/env';
import { buildCreateIssuePayload } from '@/lib/github-issue-create';
```

Append this function at the end of the file (after the existing `workOnIssue`):

```ts
/**
 * Files a new issue directly on GitHub. Does not touch Forge's database and
 * does not start any work — the issue shows up via the normal search-based
 * fetch on next page load, exactly like any issue filed on GitHub directly.
 */
export async function createIssue(
  owner: string,
  repo: string,
  input: { title: string; body?: string; labels?: string[] },
): Promise<{ ok: true } | { ok: false; error: string }> {
  await withAuth();

  const payload = buildCreateIssuePayload(input);
  if (!payload.title) {
    return { ok: false, error: 'Title is required' };
  }

  const token = env.GITHUB_APP_TOKEN;
  if (!token) {
    return { ok: false, error: 'GITHUB_APP_TOKEN not configured on the server' };
  }

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return {
      ok: false,
      error: `GitHub rejected the issue (${res.status}): ${detail.slice(0, 200)}`,
    };
  }

  return { ok: true };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 3: Run the existing test suite**

Run: `pnpm --filter @forge/web test`
Expected: all existing suites still pass (this task adds no new test file — `createIssue` is network/auth glue, matching this project's convention of not unit-testing server actions that make live HTTP calls; its pure payload-shaping logic is already covered by Task 1's tests via `buildCreateIssuePayload`).

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts"
git commit -m "feat(workspace): createIssue server action"
```

---

### Task 3: `Dialog` UI primitive

**Files:**
- Modify: `apps/web/package.json` (new dependency)
- Create: `apps/web/src/components/ui/dialog.tsx`

**Interfaces:**
- Produces: `Dialog`, `DialogPortal`, `DialogOverlay`, `DialogClose`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription` — the standard shadcn/Radix Dialog component set, matching the conventions of the existing `select.tsx`.

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @forge/web add @radix-ui/react-dialog`

This adds `@radix-ui/react-dialog` to `apps/web/package.json` under `dependencies`, at whatever version pnpm resolves as current (do not hand-edit a version number — let the install determine it, matching how `@radix-ui/react-select`/`@radix-ui/react-label` were already added).

- [ ] **Step 2: Create the primitive**

Create `apps/web/src/components/ui/dialog.tsx` (standard shadcn Dialog — no-semicolon, double-quote style, matching `select.tsx` in this same folder):

```tsx
"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml apps/web/src/components/ui/dialog.tsx
git commit -m "feat(ui): add Dialog primitive"
```

(If the lockfile is `pnpm-lock.yaml` at the repo root instead of inside `apps/web/`, add whichever path `git status` actually shows as modified — this is a pnpm workspace, so the lockfile lives at the monorepo root: `git add pnpm-lock.yaml` instead.)

---

### Task 4: `NewIssueDialog` component, wired into the Repo Workspace header

**Files:**
- Create: `apps/web/src/app/(app)/repos/[owner]/[repo]/new-issue-dialog.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`

**Interfaces:**
- Consumes: `Dialog`/`DialogTrigger`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogFooter` (Task 3), `parseLabelsInput` (Task 1), `createIssue` (Task 2).
- Produces: `NewIssueDialog({ owner, repo }: { owner: string; repo: string })` — `owner` and `repo` are the two separate path segments (e.g. `"acme"` and `"api"`), not the combined `"owner/repo"` slug.

- [ ] **Step 1: Create the dialog component**

Create `apps/web/src/app/(app)/repos/[owner]/[repo]/new-issue-dialog.tsx`:

```tsx
'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { parseLabelsInput } from '@/lib/github-issue-create';

import { createIssue } from './actions';

export function NewIssueDialog({ owner, repo }: { owner: string; repo: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labelsText, setLabelsText] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setTitle('');
    setBody('');
    setLabelsText('');
    setTitleError(null);
    setSubmitError(null);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError('Title is required');
      return;
    }
    setTitleError(null);
    setSubmitError(null);

    startTransition(async () => {
      const result = await createIssue(owner, repo, {
        title: trimmed,
        body: body.trim() || undefined,
        labels: parseLabelsInput(labelsText),
      });
      if (!result.ok) {
        setSubmitError(result.error);
        return;
      }
      setOpen(false);
      reset();
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          + New issue
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New issue</DialogTitle>
            <DialogDescription>
              Files a real issue on GitHub. It won&apos;t start any work — you&apos;ll still
              click &quot;Work on it&quot; whenever you&apos;re ready.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-1.5">
              <Label htmlFor="new-issue-title">Title</Label>
              <Input
                id="new-issue-title"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (titleError) setTitleError(null);
                }}
                autoFocus
              />
              {titleError ? <p className="text-xs text-destructive">{titleError}</p> : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-issue-body">Description</Label>
              <Textarea
                id="new-issue-body"
                rows={5}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-issue-labels">Labels</Label>
              <Input
                id="new-issue-labels"
                placeholder="bug, p1"
                value={labelsText}
                onChange={(e) => setLabelsText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Comma-separated, optional.</p>
            </div>
            {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create issue'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Wire it into the Repo Workspace header**

In `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`, add the import:

```ts
import { NewIssueDialog } from './new-issue-dialog';
```

Replace this block:

```tsx
        {mission ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/missions/${mission.id}`}>View mission</Link>
          </Button>
        ) : null}
```

with:

```tsx
        <div className="flex shrink-0 items-center gap-2">
          <NewIssueDialog owner={owner} repo={repoName} />
          {mission ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/missions/${mission.id}`}>View mission</Link>
            </Button>
          ) : null}
        </div>
```

(`owner` and `repoName` are already destructured from `params` at the top of this component — reuse them, don't re-derive from the combined `repo` string.)

- [ ] **Step 3: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/repos/acme/api` (substitute any owner/repo — dev server is likely already running on :3100)
Expected: `307` (auth redirect) or `200` if already signed in — either proves no 500/compile error.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/new-issue-dialog.tsx" "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx"
git commit -m "feat(workspace): New issue dialog in the Repo Workspace header"
```

---

### Task 5: Bump GitHub App permission to `issues: write`

**Files:**
- Modify: `apps/web/src/app/(app)/api/github/register/route.ts`

**Interfaces:** none — single manifest field change.

- [ ] **Step 1: Change the permission**

In `apps/web/src/app/(app)/api/github/register/route.ts`, in the `default_permissions` object, change:

```ts
      issues: 'read',
```

to:

```ts
      issues: 'write',
```

This block is not branched on `isLocal`, so this one change applies to both the local-dev and real-deployment manifest paths.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/api/github/register/route.ts"
git commit -m "feat(workspace): bump GitHub App to issues:write for issue creation"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass, including the new `github-issue-create.test.ts` (12 tests).

- [ ] **Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: clean across all workspace packages.

- [ ] **Step 3: Manual browser verification (requires the signed-in operator, and an existing GitHub App installation)**

Ask the operator to confirm:

1. Visiting `/repos/[owner]/[repo]` for a connected repo shows a "+ New issue" button in the header, next to "View mission" (if a standing mission exists).
2. Clicking it opens a modal with Title, Description, and Labels fields.
3. Submitting with an empty title shows an inline "Title is required" error and does not submit.
4. If the installation hasn't yet accepted the upgraded `issues: write` permission, submitting a valid title shows GitHub's rejection error inline in the dialog (not a toast, not a lost form) — confirm what GitHub's actual re-approval prompt looks like at this point, and document the exact steps taken to grant it (this is the "confirm during implementation/testing" item the spec deferred).
5. After granting the permission, submitting Title + Description + Labels (e.g. `bug, p1`) succeeds, closes the dialog, and refreshes the page.
6. The created issue is visible on the real GitHub repo's issue list (open it directly on github.com) with the correct title, body, and labels.
7. After a refresh (allowing for GitHub's search-index propagation lag — a few seconds), the new issue appears in the Forge workspace's issue list, with a working "Work on it" button, same as any other issue.

- [ ] **Step 4: Report**

Summarize verification results (pass/fail per check) to the operator, including the exact re-approval steps observed in check 4. Do not mark this task complete if checks 1-3, 5, or 6 fail. Check 7's propagation lag is a known, accepted limitation (see spec) — note the actual delay observed, but it isn't a failure unless the issue never appears after a reasonable wait (~1 minute).
