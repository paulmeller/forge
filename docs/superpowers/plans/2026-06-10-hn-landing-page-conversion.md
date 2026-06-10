# HN-Conversion Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the marketing landing page so a Hacker News reader converts (stars/clones/signs up) — factual hero, sourced claims, real artifacts, ungated quickstart.

**Architecture:** All changes are copy/JSX edits to the single marketing page plus one new self-contained section. No new components, no state, no data fetching. Every claim on the page must be either sourced (linked) or a verifiable in-repo artifact.

**Tech Stack:** Next.js 15 App Router, Tailwind utility classes (match existing inline conventions exactly), no new dependencies.

**Verification model:** This is static marketing copy — there is no unit-testable logic, so TDD does not apply. Each task verifies with (a) `pnpm --filter web typecheck` and (b) a `curl` grep against the dev server confirming the new copy renders and the removed copy is gone. The dev server runs at `http://localhost:3100` (`pnpm --filter web dev` if not already running; note the port is 3100, not the README's 3000 — `apps/web/package.json` pins `--port 3100`).

**Fact base (verified 2026-06-10, do not re-litigate):**
- Stripe Minions + "over a thousand pull requests merged each week" is VERIFIED via Stripe's engineering blog: `https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents` (author: Alistair Gray). The 1,300/week figure is secondary (InfoQ). Use "1,000+ " and link the Stripe blog.
- The Patrick Collison blockquote currently on the page ("The primary reason the Minions work…") is MISATTRIBUTED — it is a ByteByteGo author's synthesis, not a Collison quote. It MUST be removed.
- The `loopPolicy` YAML in Task 3 is copied verbatim from `skills/forge-dev/SKILL.md` (real repo artifact — re-check it matches before committing).

---

## File Structure

- Modify: `apps/web/src/app/(marketing)/page.tsx` — all copy/section changes (Tasks 1–5)
- No other files change. `RotatingMissions` and the layout are untouched.

---

### Task 0: Branch

- [ ] **Step 1: Create a working branch**

```bash
cd /Users/paulmeller/Projects/forge
git checkout -b hn-landing
```

Note: the working tree may contain an unrelated uncommitted change to `apps/web/src/app/(app)/api/chat/route.ts`. Leave it alone — never `git add -A`; stage only `page.tsx` and this plan file in the commits below.

---

### Task 1: Hero — say what it is, lead with GitHub

**Files:**
- Modify: `apps/web/src/app/(marketing)/page.tsx` (hero section, ~lines 11–42)

- [ ] **Step 1: Replace the two hero sub-paragraphs**

Old (exact current content):

```tsx
          <p className="mx-auto mb-4 max-w-[540px] text-[18px] leading-relaxed text-[#a1a1aa]">
            Forge turns any backlog into a fleet of autonomous agents. They
            read the brief, do the work, and deliver reviewable artifacts.
            Code today. Content, data, and ops tomorrow.
          </p>
          <p className="mx-auto mb-10 max-w-[480px] text-[16px] leading-relaxed text-[#52525b]">
            Everyone says design loops, not prompts. Forge is the
            open-source infrastructure that makes that sentence mean
            something.
          </p>
```

New:

```tsx
          <p className="mx-auto mb-4 max-w-[540px] text-[18px] leading-relaxed text-[#a1a1aa]">
            Forge is an open-source orchestrator that turns GitHub issues
            into fleets of sandboxed coding agents — dispatched in parallel,
            capped by budget, every action in an audit ledger you own.
          </p>
          <p className="mx-auto mb-10 max-w-[480px] text-[16px] leading-relaxed text-[#52525b]">
            Stripe merges 1,000+ autonomous PRs a week on internal
            infrastructure. Forge is that pattern, MIT-licensed.
          </p>
```

- [ ] **Step 2: Swap hero CTAs — GitHub primary, signup secondary**

Old:

```tsx
            <Link
              href="/signup"
              className="rounded-md bg-[#fafafa] px-6 py-3 text-sm font-medium text-[#09090b] transition-colors hover:bg-[#e4e4e7]"
            >
              Get Started Free
            </Link>
            <Link
              href="/docs"
              className="rounded-md border border-[#27272a] px-6 py-3 text-sm text-[#a1a1aa] transition-colors hover:border-[#3f3f46] hover:text-[#d4d4d8]"
            >
              Read the Docs
            </Link>
```

New:

```tsx
            <Link
              href={GITHUB_URL}
              className="rounded-md bg-[#fafafa] px-6 py-3 text-sm font-medium text-[#09090b] transition-colors hover:bg-[#e4e4e7]"
            >
              View on GitHub
            </Link>
            <Link
              href="/signup"
              className="rounded-md border border-[#27272a] px-6 py-3 text-sm text-[#a1a1aa] transition-colors hover:border-[#3f3f46] hover:text-[#d4d4d8]"
            >
              Get Started Free
            </Link>
```

(`GITHUB_URL` is already defined at the top of the file. The Docs link remains in the nav, so nothing is lost.)

- [ ] **Step 3: Verify**

```bash
pnpm --filter web typecheck
curl -s http://localhost:3100/ | grep -c "open-source orchestrator that turns GitHub issues"   # expect 1
curl -s http://localhost:3100/ | grep -c "makes that sentence mean"                            # expect 0
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(marketing\)/page.tsx
git commit -m "feat(landing): factual hero copy, GitHub-primary CTA"
```

---

### Task 2: Loops section — drop the discourse-riding intro

**Files:**
- Modify: `apps/web/src/app/(marketing)/page.tsx` (Loops section intro paragraph)

- [ ] **Step 1: Replace the intro paragraph**

Old:

```tsx
        <p className="mx-auto mb-14 max-w-[560px] text-center text-sm text-[#71717a]">
          The most-quoted idea in AI coding right now — and almost nobody can
          say what it looks like in practice. This is what it looks like: a
          mission is a loop. It prompts the agents, checks the work, and
          decides whether to keep going. You write the intent and the stopping
          conditions. Forge runs the loop.
        </p>
```

New:

```tsx
        <p className="mx-auto mb-14 max-w-[560px] text-center text-sm text-[#71717a]">
          A mission is a loop: it prompts the agents, checks the work, and
          decides whether to keep going. Without stopping conditions, loops
          run away — with them, they ship. You write the intent and the
          limits. Forge enforces them.
        </p>
```

(The three pillar cards — "Loops that halt", "Loops that check their own work", "Loops that compound" — stay exactly as they are.)

- [ ] **Step 2: Verify**

```bash
pnpm --filter web typecheck
curl -s http://localhost:3100/ | grep -c "Without stopping conditions"      # expect 1
curl -s http://localhost:3100/ | grep -c "most-quoted idea"                 # expect 0
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(marketing\)/page.tsx
git commit -m "feat(landing): factual loops intro, drop discourse framing"
```

---

### Task 3: Real artifact — render the actual loopPolicy in the Loops section

**Files:**
- Modify: `apps/web/src/app/(marketing)/page.tsx` (append inside the Loops section, after the three-card grid, before `</section>`)
- Reference (read-only): `skills/forge-dev/SKILL.md` lines 6–13

- [ ] **Step 1: Confirm the artifact is still accurate**

```bash
sed -n '6,13p' skills/forge-dev/SKILL.md
```

Expected (if this differs, update the JSX below to match the file — the file wins):

```
loopPolicy:
  maxTurns: 40
  noProgressTokens: 300000
  selfVerify: false
  acceptanceCriteria: |
    - The change implements the requested feature or fix.
    - pnpm -r typecheck and pnpm -r test pass.
```

- [ ] **Step 2: Add the artifact block after the three-card grid**

Insert immediately after the closing `</div>` of the `grid gap-4 md:grid-cols-3` in the Loops section, before `</section>`:

```tsx
        <div className="mx-auto mt-10 max-w-[560px]">
          <div className="rounded-lg border border-[#27272a] bg-[#0f0f11] p-5">
            <p className="mb-3 font-mono text-xs text-[#52525b]">
              skills/forge-dev/SKILL.md
            </p>
            <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-[#a1a1aa]">
{`loopPolicy:
  maxTurns: 40
  noProgressTokens: 300000
  acceptanceCriteria: |
    - pnpm -r typecheck and pnpm -r test pass`}
            </pre>
          </div>
          <p className="mt-3 text-center text-[13px] leading-relaxed text-[#52525b]">
            Real policy from the Forge skill library. Guardrails ship in the
            skill, not the prompt.
          </p>
        </div>
```

(The `selfVerify: false` line and the first acceptance criterion are elided for display brevity — that's fine because the caption says "policy from", not "the complete file". Keep the four lines shown verbatim-true to the file.)

- [ ] **Step 3: Verify**

```bash
pnpm --filter web typecheck
curl -s http://localhost:3100/ | grep -c "noProgressTokens"                 # expect 1
curl -s http://localhost:3100/ | grep -c "Guardrails ship in the"           # expect 1
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(marketing\)/page.tsx
git commit -m "feat(landing): show real loopPolicy artifact in loops section"
```

---

### Task 4: Why open source — source the Stripe claim, remove the misattributed quote

**Files:**
- Modify: `apps/web/src/app/(marketing)/page.tsx` (Why open source section)

- [ ] **Step 1: Replace the section body and blockquote**

Old (entire block between the `<h2>` and `</section>`):

```tsx
        <div className="mb-6">
          <p className="mb-4 text-[15px] leading-relaxed">
            Stripe&rsquo;s Minions system ships 1,300 PRs per week. It took a
            dedicated infrastructure team to build. That capability
            shouldn&rsquo;t require a $200/mo subscription and a proprietary
            black box.
          </p>
          <p className="text-[15px] leading-relaxed text-[#a1a1aa]">
            Forge is MIT-licensed. Self-host the engine, or use the managed
            service. The orchestration layer is open. The agents are
            world-class.
          </p>
        </div>
        <blockquote className="border-l-2 border-[#27272a] pl-4">
          <p className="text-[13px] italic leading-normal text-[#71717a]">
            &ldquo;The primary reason the Minions work has almost nothing to do
            with the AI model. It has everything to do with the
            infrastructure.&rdquo;
          </p>
          <cite className="mt-1.5 block text-xs not-italic text-[#52525b]">
            — Patrick Collison, Stripe CEO
          </cite>
        </blockquote>
```

New:

```tsx
        <div className="mb-6">
          <p className="mb-4 text-[15px] leading-relaxed">
            Stripe&rsquo;s internal{' '}
            <a
              href="https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents"
              className="underline decoration-[#3f3f46] underline-offset-2 transition-colors hover:decoration-[#71717a]"
            >
              Minions system
            </a>{' '}
            merges over a thousand autonomous PRs a week. It took a dedicated
            infrastructure team to build. That capability shouldn&rsquo;t
            require a $200/mo subscription and a proprietary black box.
          </p>
          <p className="text-[15px] leading-relaxed text-[#a1a1aa]">
            Forge is MIT-licensed. Self-host the engine, or use the managed
            service. The orchestration layer is open. The agents are
            world-class.
          </p>
        </div>
        <blockquote className="border-l-2 border-[#27272a] pl-4">
          <p className="text-[13px] italic leading-normal text-[#71717a]">
            &ldquo;over a thousand pull requests merged each week&rdquo;
          </p>
          <cite className="mt-1.5 block text-xs not-italic text-[#52525b]">
            — Stripe Engineering, on Minions
          </cite>
        </blockquote>
```

Rationale (for the engineer): the Collison attribution is false (it is a ByteByteGo author's synthesis). The replacement quote is the verbatim phrase from Stripe's own blog post, attributed to the org, with the link one paragraph above. Do not "improve" the quote — verbatim or nothing.

- [ ] **Step 2: Verify**

```bash
pnpm --filter web typecheck
curl -s http://localhost:3100/ | grep -c "Collison"                          # expect 0
curl -s http://localhost:3100/ | grep -c "stripe.dev/blog/minions"           # expect 1
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(marketing\)/page.tsx
git commit -m "fix(landing): source Stripe claim, remove misattributed quote"
```

---

### Task 5: Quickstart section — ungated self-host path

**Files:**
- Modify: `apps/web/src/app/(marketing)/page.tsx` (new section between "Why open source" and the Footer CTA)
- Reference (read-only): `README.md` "Local dev" section — commands below are copied from it

- [ ] **Step 1: Insert the new section**

Insert after the closing `</section>` of "Why open source" and its following `<hr className="border-[#1a1a1e]" />`, replacing that single `<hr>` with:

```tsx
      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* Quickstart */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        <div className="mx-auto max-w-[600px]">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            Self-host it tonight
          </h2>
          <p className="mb-6 text-[15px] leading-relaxed text-[#71717a]">
            Node 22 and pnpm 10. No account, no API call home. The managed
            service is optional.
          </p>
          <div className="rounded-lg border border-[#27272a] bg-[#0f0f11] p-5">
            <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-[#a1a1aa]">
{`git clone https://github.com/paulmeller/forge && cd forge
pnpm install
cp apps/web/.env.example apps/web/.env.local
cp apps/tick/.env.example apps/tick/.env.local
pnpm --filter @forge/db db:generate
pnpm --filter @forge/db db:migrate
pnpm dev`}
            </pre>
          </div>
        </div>
      </section>

      <hr className="border-[#1a1a1e]" />
```

- [ ] **Step 2: Verify the commands against the README (the README wins)**

```bash
sed -n '42,56p' README.md
```

If the README's "Local dev" block differs from the JSX above, change the JSX to match.

- [ ] **Step 3: Verify rendering**

```bash
pnpm --filter web typecheck
curl -s http://localhost:3100/ | grep -c "Self-host it tonight"             # expect 1
curl -s http://localhost:3100/ | grep -c "db:migrate"                       # expect 1
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(marketing\)/page.tsx
git commit -m "feat(landing): add ungated self-host quickstart section"
```

---

### Task 6: Final claims sweep + full-page verification

**Files:**
- Modify (only if sweep finds issues): `apps/web/src/app/(marketing)/page.tsx`

- [ ] **Step 1: Sweep the rendered page for unsourced/false-positive claims**

```bash
curl -s http://localhost:3100/ | grep -o "1,300\|Collison\|Everyone says\|most-quoted"
```

Expected: no output. Any hit means an earlier task was applied incompletely — fix it in `page.tsx` and re-run.

- [ ] **Step 2: Confirm the two illustrative "200" figures read as illustration, not track record**

The Dispatch card ("1 mission → 200 agents") and Review card ("200 artifacts ready for review") are design-capacity illustrations inside a hypothetical walkthrough — leave them, they are framed by "Each agent gets…" pattern copy, not "we did this". No edit required. This step exists so the sweep is a decision, not an oversight.

- [ ] **Step 3: Full verification**

```bash
pnpm --filter web typecheck
pnpm --filter web lint
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/   # expect 200
```

- [ ] **Step 4: Commit the plan file and any sweep fixes**

```bash
git add docs/superpowers/plans/2026-06-10-hn-landing-page-conversion.md apps/web/src/app/\(marketing\)/page.tsx
git commit -m "docs: HN landing page conversion plan"
```

---

## Out of scope (deliberate)

- **Screenshots / asciinema of a real mission** — needs a real recorded run; do this manually before the HN post, slot it under the CI section.
- **"Show HN" post copy** — separate deliverable.
- **A/B variants for general vs HN traffic** — single page; revisit only if hero conversion drops for non-HN traffic.
- The two `route.ts` review findings and the invalid model ID in `deploy.yml` — tracked separately from this plan.
