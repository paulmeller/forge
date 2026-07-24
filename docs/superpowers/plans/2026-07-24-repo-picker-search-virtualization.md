# Repo Picker Search + Virtualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/setup` page's repo picker usable when a GitHub App installation has many repos, by adding a live search box and virtualized (windowed) rendering of the checkbox list.

**Architecture:** `RepoPicker` sorts its available repo list once, filters it by a `query` string kept in local state, and renders the filtered list through `@tanstack/react-virtual`'s `useVirtualizer` inside a fixed-height scroll container — so only the rows currently in view are mounted.

**Tech Stack:** Next.js App Router, React, `@tanstack/react-virtual` (new dependency), existing shadcn `Input`/`Checkbox`/`Button`/`Spinner` components.

## Global Constraints

- Sort `availableRepos` alphabetically, case-insensitively, once: `[...availableRepos].sort((a, b) => a.localeCompare(b))`.
- Filter is a case-insensitive substring match: `repo.toLowerCase().includes(query.toLowerCase())`.
- Scroll container: fixed height `max-h-80` (320px), `overflow-y-auto`, keeps the `rounded-md border` styling that today lives on the list wrapper div.
- Virtualizer row height is fixed: `estimateSize: () => 40`.
- Search input placeholder: `"Search repos..."`. No debounce — filtering an in-memory string array is cheap.
- Empty states: `availableRepos.length === 0` keeps today's exact message unchanged. New case: `filteredRepos.length === 0 && query !== ''` shows `` `No repos match "${query}".` ``.
- `checked` (the `Set<string>` of selected repos), `handleSave`, the `ghRepos === null` fallback note, and the Save button's behavior are all UNCHANGED — `checked.size` must reflect the full selection regardless of what's currently filtered/rendered.
- No new test file — this app does not unit-test page/rendering components, and `RepoPicker` has no existing test file today.

---

### Task 1: Add search + virtualization to RepoPicker

**Files:**
- Modify: `apps/web/package.json` (add `@tanstack/react-virtual` dependency)
- Modify: `apps/web/src/app/(app)/setup/repo-picker.tsx` (full rewrite of the render logic; `handleSave`/`toggle`/state for `checked`/`pending`/`error` stay as-is)

**Interfaces:**
- Consumes: `Input` — named export from `@/components/ui/input` (confirmed: `React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>`, accepts standard `<input>` props including `value`, `onChange`, `placeholder`, `className`).
- Consumes: `useVirtualizer` — named export from `@tanstack/react-virtual`. Called as `useVirtualizer({ count, getScrollElement, estimateSize })`, returns an object with `.getTotalSize(): number` and `.getVirtualItems(): Array<{ key: number | string; index: number; start: number; size: number }>`.
- Produces: no new exports — `RepoPicker`'s props (`installationId`, `ghRepos`, `connectedRepos`) and default export shape are unchanged, so nothing that imports `RepoPicker` needs to change.

- [ ] **Step 1: Install `@tanstack/react-virtual`**

Run from the repo root:

```bash
pnpm --filter @forge/web add @tanstack/react-virtual@^3.14.8
```

Expected: `apps/web/package.json`'s `dependencies` gains an entry `"@tanstack/react-virtual": "^3.14.8"`, and `pnpm-lock.yaml` updates. No other files change.

- [ ] **Step 2: Verify the install**

Run: `pnpm --filter @forge/web ls @tanstack/react-virtual`
Expected: prints the installed version (`3.14.8` or the resolved semver-matching version), confirming the package is present in `node_modules`.

- [ ] **Step 3: Rewrite `apps/web/src/app/(app)/setup/repo-picker.tsx`**

Replace the entire file with:

```tsx
'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useVirtualizer } from '@tanstack/react-virtual';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

import { syncRepos } from './actions';

export function RepoPicker({
  installationId,
  ghRepos,
  connectedRepos,
}: {
  installationId: string;
  ghRepos: string[] | null;
  connectedRepos: string[];
}) {
  const router = useRouter();
  const availableRepos = ghRepos ?? connectedRepos;
  const [checked, setChecked] = useState<Set<string>>(new Set(connectedRepos));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const sortedRepos = useMemo(
    () => [...availableRepos].sort((a, b) => a.localeCompare(b)),
    [availableRepos],
  );
  const filteredRepos = useMemo(
    () => sortedRepos.filter((repo) => repo.toLowerCase().includes(query.toLowerCase())),
    [sortedRepos, query],
  );

  const virtualizer = useVirtualizer({
    count: filteredRepos.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
  });

  function toggle(repo: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  }

  async function handleSave() {
    setError('');
    setPending(true);
    try {
      const result = await syncRepos(installationId, [...checked]);
      if (result?.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {ghRepos === null && (
        <p className="text-xs text-muted-foreground">
          Couldn&rsquo;t reach GitHub to list new repos right now — showing already-connected repos
          only. Try again shortly to add more.
        </p>
      )}
      {availableRepos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repos available. Check the GitHub App&rsquo;s repository access settings.
        </p>
      ) : (
        <>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search repos..."
          />
          {filteredRepos.length === 0 ? (
            <p className="text-sm text-muted-foreground">No repos match &ldquo;{query}&rdquo;.</p>
          ) : (
            <div ref={scrollRef} className="max-h-80 overflow-y-auto rounded-md border p-3">
              <div
                style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
              >
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const repo = filteredRepos[virtualItem.index];
                  return (
                    <label
                      key={virtualItem.key}
                      className="absolute left-0 top-0 flex w-full items-center gap-2 text-sm"
                      style={{
                        height: virtualItem.size,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <Checkbox checked={checked.has(repo)} onCheckedChange={() => toggle(repo)} />
                      <span className="font-mono">{repo}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button onClick={handleSave} disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        Save selection ({checked.size} selected)
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: exits 0, no new errors.

- [ ] **Step 5: Manual dev-server verification**

Start the dev server (`pnpm --filter @forge/web dev`) and navigate to `/setup` while signed in with a connected GitHub App installation.

- Confirm the repo list renders inside a scrollable box and typing in the search input narrows the visible checkboxes to matching repo names.
- Confirm clearing the search input restores the full list.
- Check a repo, then type a query that filters it out of view, then clear the query — confirm the checkbox is still checked (selection state survives filtering).
- Confirm "Save selection (N selected)" still reflects the true count of checked repos, not just currently-visible ones.

If the sandbox has no real authenticated GitHub installation to test against, say so explicitly in the task report rather than claiming this was verified — do not fabricate a successful manual check.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/app/\(app\)/setup/repo-picker.tsx
git commit -m "feat(web): add search + virtualization to the setup repo picker"
```
