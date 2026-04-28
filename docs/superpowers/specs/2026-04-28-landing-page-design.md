# Forge Landing Page Design Spec

## Goal

Drive GitHub adoption (stars, forks, clones) and establish Forge as the credible open-source alternative to Factory Missions. Sign-up is secondary — the repo is the product.

## Audience

Three visitors, one page:

1. **Platform/DevEx engineer** — owns "upgrade all 140 services," evaluating tools
2. **Engineering manager/director** — deciding whether to adopt fleet-scale agents
3. **Open-source developer** — clicked through from HN/Twitter, deciding if it's interesting

The hero is written for all three via the "software factory" positioning — it speaks to the paradigm, not the tactical pain point.

## Tone

Calm authority. Linear-style. No exclamation marks, no "revolutionary," no hype. The code is open; let that speak. Confident because there's nothing to hide.

## Positioning

- **Primary frame:** "The open-source software factory"
- **Competitive target:** Factory (the company) — referenced indirectly via "$200/mo subscription and a proprietary black box"
- **Validation anchor:** Stripe Minions (1,300 PRs/week) + Patrick Collison quote as proof the approach works

## Page Structure

The page is a single-scroll, dark-themed landing page with five sections and a sticky nav. All content lives within the existing Next.js app at the root route (`/`).

### Nav (sticky)

- Logo: "Forge" (text, 16px, weight 700)
- Links: Docs, GitHub
- Right: "★ Star" button (primary style)
- Sticky with backdrop blur, border-bottom separator

### Section 1: Hero

**Layout:** Two-column. Hero text left, Console mock right.

**Left column:**
- Badge: "MIT Licensed" (pill, uppercase, 11px, border)
- Headline: "The open-source software factory." (52px, weight 600, tight letter-spacing)
- Subline: "Orchestrate fleet-scale autonomous code changes. Every action in a ledger you own. Every dollar tracked." (17px, zinc-500)
- Buttons: "★ Star on GitHub" (primary) + "Quickstart →" (secondary/outline)

**Right column: Console Mock**
- Dark card (18181b background, 27272a border, rounded)
- Label: "Mission Control" (10px, uppercase, zinc-600)
- Three mission rows, each with:
  - Name (12px, zinc-400)
  - Status indicator: colored dot + progress fraction (green/blue/amber)
  - Progress bar (3px height, colored fill)
- Divider line
- Budget row: "Budget" label + "$12.40 / $50.00"

**Example mission rows:**
1. "bump fast-glob" — 138/140 — green — 98% fill
2. "add OTel spans" — 24/67 — blue — 36% fill
3. "fix CVE-2024-4067" — 8/22 — amber — 36% fill

### Section 2: Value Props

**Layout:** Left-aligned, stacked vertically. Each prop is a flex row: bold word + explanation.

Three props:
1. **Auditable.** — "Every action in an append-only ledger. Every state change queryable. You own the record."
2. **Budgeted.** — "Per-mission spend caps in dollars and tokens. Auto-pause before overrun. No surprises."
3. **Portable.** — "Claude Managed Agents or self-hosted gateway. Swap with one env var. No lock-in."

**Typography:** Word is 32px, weight 600, white. Description is 15px, zinc-500. Baseline-aligned.

### Section 3: How a Mission Runs

**Layout:** Centered heading + subtitle, then horizontal 4-step pipeline.

- Heading: "How a Mission runs" (24px, centered)
- Subtitle: `"Bump fast-glob to ^3.3.2 across 140 repos"` (14px, zinc-500, centered)

**Pipeline:** Four step cards connected by → arrows.

Each step card:
- Background: 18181b, border 27272a, rounded
- Step number (18px, zinc-600)
- Step name (14px, white, weight 600)
- Description below card (11px, zinc-600, 3 lines)

Steps:
1. **Plan** — Define target repos. Preview tasks. Set budget.
2. **Dispatch** — Parallel agent sessions. One per repo. Concurrency-controlled.
3. **Gate** — Open PRs. Wait for CI. Retry on failure.
4. **Merge** — Auto-merge on pass. Flag for review. Track in Ledger.

### Section 4: Why Open Source

**Layout:** Left-aligned heading, two narrative paragraphs, blockquote.

- Heading: "Why open source" (24px, weight 600)
- Paragraph 1 (white, 15px): "Stripe runs 1,300 autonomous PRs per week with an internal tool their engineers built. That capability shouldn't require a $200/mo subscription and a proprietary black box."
- Paragraph 2 (zinc-400, 15px): "Forge is MIT-licensed fleet orchestration. The Ledger is in your database. The budget controls are in your config. The agent adapter is a single interface you can swap, extend, or replace."
- Blockquote (zinc-500, 13px, italic, left border 2px zinc-800): "The primary reason the Minions work has almost nothing to do with the AI model. It has everything to do with the infrastructure." — Patrick Collison, Stripe CEO

### Section 5: Footer CTA

**Layout:** Full-width, centered.

- Headline: "Start a Mission." (36px, weight 600)
- Subtitle: "First Mission running in under 10 minutes. MIT licensed. Free forever." (15px, zinc-500)
- Buttons: Same as hero — "★ Star on GitHub" (primary) + "Quickstart →" (secondary)

### Bottom Bar

- Full-width, border-top separator
- Left: "MIT License · Forge" (12px, zinc-600)
- Right: "GitHub" link (12px, zinc-600)

## Design System

### Colors (dark theme only — no light mode toggle on landing page)

| Token | Value | Usage |
|-------|-------|-------|
| bg | #09090b | Page background |
| surface | #18181b | Cards, console mock |
| border | #27272a | Borders, dividers |
| text-primary | #fafafa | Headlines, bold words |
| text-secondary | #a1a1aa | Body copy |
| text-muted | #71717a | Descriptions, subtitles |
| text-dim | #52525b | Labels, step numbers, citations |
| accent-green | #22c55e | Success states, MIT badge in table |
| accent-blue | #3b82f6 | In-progress states |
| accent-amber | #f59e0b | Pending/warning states |

### Typography

- Font: system-ui stack (matches existing app)
- Hero headline: 52px, weight 600, letter-spacing -1.5px
- Section headings: 24px, weight 600, letter-spacing -0.5px
- Value prop words: 32px, weight 600, letter-spacing -1px
- Body: 15px, line-height 1.5-1.65
- Small text: 11-13px

### Layout

- Max content width: 960px, centered
- Section padding: 72px vertical
- Hero padding: 80px top/bottom
- Horizontal padding: 48px
- Footer CTA and bottom bar: full-width (no max-width constraint)
- Dividers: 1px solid #1a1a1e between sections

### Components

Uses existing shadcn/ui Button component for CTAs. Console mock is a custom component. Everything else is standard HTML/CSS with Tailwind classes.

### Interactivity

- Nav: sticky with backdrop-filter blur
- Console mock: static (not animated in v1 — animation could be added later)
- Buttons: standard hover states from existing design system
- No scroll animations in v1

## Technical Notes

- Replaces the existing minimal `apps/web/src/app/page.tsx`
- Dark theme only for the landing page (no theme toggle needed — the app dashboard retains its toggle)
- No new dependencies required — uses existing Tailwind + shadcn/ui setup
- Responsive behavior: stack hero columns on mobile, stack pipeline steps vertically on narrow screens
- GitHub star count: not displayed in v1 (avoid stale counts and API complexity). The "★ Star on GitHub" button text is sufficient.
- Links: "Star on GitHub" → repo URL, "Quickstart" → README or docs quickstart section, "Docs" → docs route

## Mockup Reference

Full-page mockup available at: `.superpowers/brainstorm/99713-1777377677/content/full-page-preview.html`
