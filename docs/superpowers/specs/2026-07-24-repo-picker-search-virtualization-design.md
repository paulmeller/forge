# Repo Picker Search + Virtualization — Design

## Motivation

The `/setup` page's repo picker (`apps/web/src/app/(app)/setup/repo-picker.tsx`) renders every repo a GitHub App installation can see as a flat checkbox list with no search, filter, or pagination. For an installation with many repos, this list "goes on for pages" — both hard to scan for a specific repo and visually cluttered regardless of whether you're searching.

## Scope

- Add a live search/filter input above the checkbox list in `RepoPicker`.
- Virtualize the checkbox list so only visible rows render, using `@tanstack/react-virtual` (new dependency).
- Sort the available repo list alphabetically (case-insensitive, by full `owner/repo` name) as the baseline order for both display and filtering.

## Out of Scope

- Sorting/pinning already-connected repos to the top — adds complexity to virtualized scroll position for limited benefit; alphabetical sort + search already solves findability.
- Grouping by org/owner — a single GitHub App installation is scoped to one account, so there's nothing to group by.
- Server-side or paginated fetching — `listInstallationRepositories` already fetches the full list in one shot; this only changes how it's rendered and searched client-side.

## Design

### Data flow

`availableRepos` (the existing `ghRepos ?? connectedRepos` list) is sorted alphabetically once via `[...availableRepos].sort((a, b) => a.localeCompare(b))`. A new `query` state string (from the search input) filters this sorted list case-insensitively by substring match into `filteredRepos`. `filteredRepos` is what gets virtualized — fewer matches means fewer virtual rows, not a separate rendering path.

Checkbox state (`checked: Set<string>`, keyed by repo full name) is unaffected by filtering: typing into search, then clearing it, does not lose any selection — the underlying `checked` set is independent of what's currently filtered/rendered.

### Virtualization

Uses `useVirtualizer` from `@tanstack/react-virtual`:
- A scrollable container (`ref`) with a fixed height (`max-h-80`, i.e. 320px) and `overflow-y-auto`, replacing the current `rounded-md border p-3` div.
- `estimateSize: () => 40` (fixed-height rows — each checkbox row is a simple single-line label, no wrapping expected).
- `count: filteredRepos.length`, `getScrollElement: () => containerRef.current`.
- Rendered rows are absolutely positioned within a spacer div of `getTotalSize()` height, per `@tanstack/react-virtual`'s standard pattern (translateY per virtual item's `start` offset).

### Search input

A standard `Input` (reusing the existing shadcn `Input` component, consistent with the rest of the app's form fields) placed directly above the virtualized container, with a placeholder like "Search repos...". Updates `query` on every keystroke (no debounce needed — filtering a client-side array of strings is cheap at any realistic repo count).

### Empty states

- No repos available at all (existing case, `availableRepos.length === 0`): unchanged — "No repos available. Check the GitHub App's repository access settings."
- Repos exist but none match the current search query (`filteredRepos.length === 0 && query !== ''`): new message, "No repos match \"`{query}`\"."

### Unaffected behavior

- The `ghRepos === null` fallback note ("Couldn't reach GitHub...") is unchanged.
- `handleSave`'s try/catch/finally (from the prior review-fix pass) and the "Save selection (N selected)" button are unchanged — `checked.size` still reflects the full selection, not just what's currently filtered/visible.

## New Dependency

`@tanstack/react-virtual` added to `apps/web/package.json`. Headless (no imposed styling), works naturally with the existing shadcn/Radix-based component set.

## Testing

No new automated test coverage — consistent with this app's established pattern of not unit-testing page/rendering components (per the original `/setup` redesign spec, `RepoPicker` itself has no test file). Manual verification: type a query, confirm the list narrows and unmatched repos aren't in the DOM (virtualization); clear the query, confirm the full sorted list returns and prior checkbox selections are preserved.
