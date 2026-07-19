# New Mission Composer — Design

Date: 2026-07-15
Status: approved (brainstorm complete)
Route: `/missions/new` (`apps/web/src/app/(app)/missions/new/`)

## Problem

The New Mission page is an 18-field configuration form spread across seven
stacked cards. Three problems, confirmed with the operator:

1. **Too long.** The happy path needs three decisions (goal, mission type,
   target); the page fronts every policy knob regardless of relevance.
2. **Too much manual config.** Agent ID, GitHub installation ID, and vault ID
   must be pasted as opaque strings even though Setup and env defaults
   (`FORGE_DEFAULT_AGENT_ID`, `FORGE_DEFAULT_GITHUB_VAULT_ID`) already know
   them.
3. **Generic look.** Plain zinc shadcn cards; none of the AgentStep product
   identity the marketing pages carry.

## Framing

The page is a **composer that launches the Planner**, not the commitment
point. Missions start in `draft`; the Planner emits Tasks; the operator
reviews the plan before anything dispatches. (Same insight Factory.ai builds
its Missions flow around: the approval gate is the *plan*, not the creation
form.) Because the real review happens at plan preview, the composer earns
being minimal.

## Page structure (top to bottom)

1. **Header** — "New Mission" + subline: "Describe the work. Forge plans it
   into Tasks you review before anything dispatches."
2. **Goal** — hero textarea (~5 rows). No Name field; the Mission name is
   derived server-side from the goal's first sentence (truncated to 80 chars,
   fallback "Untitled Mission"), editable later from the mission page or via
   the Advanced override.
3. **Mission type** — existing three radio-cards (Fleet / Single repo /
   Bug triage), Single default, semantics unchanged.
4. **Target** — swaps by type:
   - Single repo → single-select repo picker (plain shadcn `Select` in v1;
     not searchable — combobox is a later upgrade)
   - Fleet → same repo list as multi-select (chips/checkboxes + count badge)
   - Bug triage → existing issue-query input, unchanged
5. **Create Mission** (primary, lime) + defaults-transparency line beside it,
   e.g. `agent from Setup · budget $200 · plan reviewed before dispatch —
   Advanced settings` ("Advanced settings" toggles the disclosure).
6. **Advanced** (one collapsed disclosure, grouped by subheadings — not seven
   cards): Name override, Skill, Backend, Agent ID, Decomposition strategy,
   Concurrency cap, AI review + self-verify, Budget (USD / tokens / soft %
   / hard %), Per-task hard stops (max turns / max tokens / no-progress
   tokens), GitHub overrides (installation ID, vault ID).

Above-the-fold decisions: **goal + type + target = 3.**

## Data flow

### Repo picker

`page.tsx` (server component) queries `github_installation_repos` joined
through the user's `github_installations` rows and passes
`availableRepos: string[]` into the form. Empty list (GitHub not connected)
→ both pickers degrade to today's free-text inputs plus the nudge banner;
the form never blocks. The submitted field remains `targetRepos` text in all
cases, so `parseRepoList` and the server-action contract are untouched.

v1 picker components: shadcn `Select` for single; checkbox/chip list for
multi. A combobox upgrade is out of scope.

### Defaults resolution

New server helper `resolveMissionDefaults(userId)` →
`{ agentId, githubInstallationId, githubVaultId, source }`:

1. User's `github_installations` row (per-user `agentId`, `githubVaultId`,
   `installationId` captured at Setup)
2. Env fallback: `FORGE_DEFAULT_AGENT_ID`, `FORGE_DEFAULT_GITHUB_VAULT_ID`
3. Neither → fields empty, nudge shown

Resolved values render as **pre-filled, editable inputs inside Advanced**
(hidden config stays inspectable) and drive the transparency line
("agent from Setup" / "agent from env default" / "no agent — connect in
Setup").

### Server action

`createMissionAction` gains exactly one behavior: derive `name` from `goal`
when the name field is absent/blank (`deriveMissionName(goal)`: first
sentence, ≤80 chars, fallback "Untitled Mission"). Resolved defaults arrive
as ordinary pre-filled form fields, so no other plumbing changes.

No schema or DB changes.

### Nudge

When agent or GitHub IDs resolve to nothing: soft amber banner above Create —
"Missions can be planned now, but connect GitHub in Setup before
dispatching." Creation proceeds to draft as normal (never blocks).

## Visual treatment

Scoped to this page first; tokens defined globally so other console pages can
adopt them later.

- **Page title** in `font-title` (VVDSFifties), uppercase — the face requires
  uppercase.
- **Lime accent as the interaction color**: Create button (lime gradient bg,
  `--accent-ink` text via a new `accent` Button variant), selected
  mission-type card ring, focus rings, checked checkboxes. Implemented as CSS
  variables + the Button variant, not a Tailwind theme overhaul. Everything
  else stays zinc.
- **Density pass** in Advanced: tighter spacing, uppercase 11px group labels
  (the mockup's `muted-label` treatment) instead of full Card headers.
- **Both themes**: lime validated on zinc-950 and white; selected/checked
  foreground uses the dark ink color in both.

## Error handling

- Existing `FieldError` + zod messages unchanged.
- Derived name is guaranteed non-empty (fallback), so it cannot fail zod.
- Empty repo selection for fleet/single → existing `targetRepos` zod error,
  rendered under the picker.

## Testing

- Unit (vitest): `deriveMissionName` (first-sentence, truncation, fallback);
  `resolveMissionDefaults` precedence (installation → env → none).
- Render test: Advanced fields absent from the accessibility tree until
  expanded; mission-type radiogroup semantics (`role="radiogroup"`,
  `role="radio"`, `aria-checked`) preserved.
- Manual: create a mission end-to-end with only goal + repo; confirm draft
  status and resolved agent ID; confirm nudge appears with no Setup and no
  env defaults.

## Out of scope

- Wizard/multi-step flow (rejected).
- Issue picker inside Single repo (explicitly rejected in an earlier round).
- Chat-first creation (exists separately; unaffected).
- Combobox repo search, plan-preview redesign, console-wide re-theme.
