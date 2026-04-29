# Forge Landing Page Design Spec

## Goal

Drive GitHub adoption (stars, forks, clones) and establish Forge as the purpose-built orchestration layer for Claude Managed Agents. Sign-up is secondary — the repo is the product.

## Audience

Three visitors, one page:

1. **Platform/DevEx engineer** — owns "upgrade all 140 services," evaluating tools
2. **Engineering manager/director** — deciding whether to adopt fleet-scale agents
3. **Open-source developer** — clicked through from HN/Twitter, deciding if it's interesting

The hero anchors on the relationship to Claude Managed Agents — what Forge is, what it's built on, and what CMA doesn't provide.

## Tone

Calm authority. Linear-style. No exclamation marks, no "revolutionary," no hype. The code is open; let that speak. Confident because there's nothing to hide.

## Positioning

- **Primary frame:** "Fleet orchestration for Claude Managed Agents" — Forge is the orchestration layer Anthropic didn't build
- **Relationship to CMA:** CMA provides the execution primitive (single agent, single container, single task). Forge provides everything above that — planning, dispatch, gating, budgets, audit.
- **Competitive angle:** Factory built their own agent engine and charge $200/mo. Forge builds on Anthropic's and is open-source.
- **Validation anchor:** Stripe Minions (1,300 PRs/week) + Patrick Collison quote as proof the approach works
- **Ecosystem signal:** "Built on Claude Managed Agents" — like Vercel on Next.js, Supabase on Postgres

## Page Structure

The page is a single-scroll, dark-themed landing page with six sections and a sticky nav. All content lives within the existing Next.js app at the root route (`/`).

### Nav (sticky)

- Logo: "Forge" (text, 16px, weight 700)
- Links: Docs, GitHub
- Right: "★ Star" button (primary style)
- Sticky with backdrop blur, border-bottom separator

### Section 1: Hero

**Layout:** Two-column. Hero text left, Console mock right.

**Left column:**
- Badge: "Built on Claude Managed Agents" (pill, uppercase, 11px, border)
- Headline: "Fleet orchestration for Claude Managed Agents." (52px, weight 600, tight letter-spacing)
- Subline: "Plan missions. Dispatch agents in parallel. Gate on CI. Auto-merge. Track every dollar." (17px, zinc-500)
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
1. **Auditable.** — "Managed Agents doesn't log what happened across your fleet. Forge does. Every action, every state change, in a ledger you own."
2. **Budgeted.** — "CMA bills per session-hour. Forge caps spend per mission. Auto-pause at 80%. No fleet-wide cost surprises."
3. **Portable.** — "Claude Managed Agents today. Self-hosted gateway tomorrow. Swap with one env var. No lock-in."

**Typography:** Word is 32px, weight 600, white. Description is 15px, zinc-500. Baseline-aligned.

### Section 3: How It Fits

**NEW SECTION.** A simple three-layer stack showing where Forge sits in the architecture.

**Layout:** Centered heading, then a vertical stack of three labeled layers.

- Heading: "Where Forge fits" (24px, centered)
- Subline: "Managed Agents runs the agent. Forge runs the fleet." (14px, zinc-500, centered)

**Three layers (top to bottom):**

| Layer | Label | Description | Visual |
|-------|-------|-------------|--------|
| Top | **You** | "Bump fast-glob across 140 repos" | zinc-700 background, text-dim |
| Middle | **Forge** | Plan → Dispatch → Gate → Merge | surface background, white text, highlighted border |
| Bottom | **Claude Managed Agents** | Single agent, single container, single task | zinc-800 background, text-dim |

The middle layer (Forge) is visually emphasized — brighter border, white text. The other two are dimmed. This makes it instantly clear Forge is the orchestration layer between the user and CMA.

### Section 4: How a Mission Runs

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

### Section 5: Why Open Source

**Layout:** Left-aligned heading, two narrative paragraphs, blockquote.

- Heading: "Why open source" (24px, weight 600)
- Paragraph 1 (white, 15px): "Stripe runs 1,300 autonomous PRs per week with an internal tool their engineers built. That capability shouldn't require a $200/mo subscription and a proprietary black box."
- Paragraph 2 (zinc-400, 15px): "Forge is MIT-licensed fleet orchestration built on Anthropic's Managed Agents API. The engine is world-class. Forge is the fleet management system it was missing."
- Blockquote (zinc-500, 13px, italic, left border 2px zinc-800): "The primary reason the Minions work has almost nothing to do with the AI model. It has everything to do with the infrastructure." — Patrick Collison, Stripe CEO

### Section 6: Footer CTA

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
| surface | #18181b | Cards, console mock, Forge layer |
| border | #27272a | Borders, dividers |
| text-primary | #fafafa | Headlines, bold words |
| text-secondary | #a1a1aa | Body copy |
| text-muted | #71717a | Descriptions, subtitles |
| text-dim | #52525b | Labels, step numbers, citations |
| accent-green | #22c55e | Success states |
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

Uses existing shadcn/ui Button component for CTAs. Console mock is a custom component. Stack diagram is a custom component. Everything else is standard HTML/CSS with Tailwind classes.

### Interactivity

- Nav: sticky with backdrop-filter blur
- Console mock: static (not animated in v1 — animation could be added later)
- Buttons: standard hover states from existing design system
- No scroll animations in v1

## Technical Notes

- Replaces the existing minimal `apps/web/src/app/page.tsx`
- Dark theme only for the landing page (no theme toggle needed — the app dashboard retains its toggle)
- No new dependencies required — uses existing Tailwind + shadcn/ui setup
- Responsive behavior: stack hero columns on mobile, stack pipeline steps vertically on narrow screens, stack diagram layers remain vertical (already mobile-friendly)
- GitHub star count: not displayed in v1 (avoid stale counts and API complexity). The "★ Star on GitHub" button text is sufficient.
- Links: "Star on GitHub" → repo URL, "Quickstart" → README or docs quickstart section, "Docs" → docs route

---

# Docs Site Design Spec

## Goal

Provide comprehensive, searchable documentation for Forge. Serves as the "Docs" link from the landing page nav and the "Quickstart →" CTA destination.

## Framework

**Fumadocs** — Next.js App Router native, MDX, built-in search, shadcn-compatible. Chosen because it fits the existing monorepo stack (Next.js 15, pnpm, Tailwind, shadcn/ui) with no separate build pipeline.

## Location

Separate monorepo package: `apps/docs`. Deployed independently. Intended for a subdomain like `docs.forge.dev`.

## Design

- Dark theme matching the landing page (bg #09090b, same zinc color palette)
- Sidebar navigation with collapsible sections
- Full-text search (Fumadocs built-in)
- Breadcrumbs, prev/next navigation
- Table of contents sidebar on each page
- Mobile-responsive with hamburger nav

## Content Structure

### 1. Getting Started

| Page | Content |
|------|---------|
| Introduction | What is Forge, who it's for, how it relates to Claude Managed Agents, what it is not |
| Quickstart | 10-minute first Mission — install, configure .env, run dev, create a Mission, watch it complete |
| Configuration | .env variables, Anthropic API key, GitHub token, database setup, optional settings |

### 2. Concepts

| Page | Content |
|------|---------|
| Missions & Tasks | Lifecycle states, concurrency control, DAG dependencies, the relationship between Mission and Task |
| The Ledger | Append-only event log, event types, querying, role tags (forge/model/agent/session) |
| Budget Controls | Per-Mission budgets (USD + tokens), auto-pause threshold, raising/lowering budgets |
| Skills | Declarative playbooks, goal templates with variables, step-by-step instructions, tool restrictions |
| Retrospectives & Memory | Post-Mission analysis, skill diff proposals, memory entries, review gate, confidence scoring |
| Backend Adapters | Managed Agents vs. Gateway, the BackendAdapter interface, swapping via env var |

### 3. Architecture

| Page | Content |
|------|---------|
| System Overview | Two services (forge-web + forge-tick), stateless design, Cloud Run deployment model |
| State Machine | Pure transition functions, Mission and Task lifecycles, state diagrams |
| Gate Lifecycle | PR creation → CI polling → retry-with-feedback → auto-merge/flag-for-review flow |

### 4. Guides

| Page | Content |
|------|---------|
| Writing a Custom Skill | Skill file format, variables, constraints, tool restrictions, testing a Skill locally |
| Deploying to Cloud Run | Production deployment steps, Cloud Scheduler setup, Turso database, env configuration |
| Connecting to AgentStep Gateway | Gateway setup, contract tests, switching from Managed Agents |

### 5. API Reference

| Page | Content |
|------|---------|
| Missions API | CRUD endpoints, request/response schemas, status transitions |
| Tasks API | CRUD endpoints, filtering, status updates |
| Webhooks | Incoming webhook format (from Managed Agents), event types, verification |

### 6. Contributing

| Page | Content |
|------|---------|
| Development Setup | Prerequisites, clone, install, env setup, running dev servers |
| Project Conventions | TypeScript strict, Prettier, conventional commits, testing philosophy (no mocks) |
| Testing | Vitest, pure function extraction, running tests, writing new tests |

## Technical Notes

- Content authored in MDX files in `apps/docs/content/`
- Fumadocs handles routing, search indexing, and TOC generation from MDX frontmatter
- Search: Fumadocs built-in (no Algolia needed in v1)
- Code blocks: syntax highlighting via Fumadocs/Shiki
- Links from landing page: "Docs" nav link → docs root, "Quickstart →" → quickstart page
- Versioning: not needed in v1 (single version, docs evolve with main branch)

## Mockup Reference

Landing page mockup: `.superpowers/brainstorm/99713-1777377677/content/full-page-preview.html`
