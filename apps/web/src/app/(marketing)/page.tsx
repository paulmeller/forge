import Link from 'next/link';

import { cn } from '@/lib/utils';

import { RotatingMissions } from './_components/rotating-missions';

const GITHUB_URL = 'https://github.com/paulmeller/forge';

// AgentStep product display style: VVDSFifties is uppercase-only.
const display = 'font-bold font-title uppercase';
const mono = 'font-mono';
const gradientText = 'bg-[image:var(--text-gradient)] bg-clip-text text-transparent';
const h2 = cn(display, 'text-foreground text-[clamp(2rem,5vw,3.5rem)] leading-[0.9]');

const steps = [
  {
    n: 1,
    title: 'Describe',
    panel: (
      <>
        <p className={cn(mono, 'text-xs text-muted-foreground/60')}>Issue, ticket, or brief:</p>
        <p className={cn(mono, 'mt-2 text-xs text-foreground')}>@forge add rate limiting to /api/users</p>
        <p className={cn(mono, 'mt-1 text-xs text-muted-foreground/60')}>@forge review this contract against our new policy</p>
        <p className={cn(mono, 'mt-1 text-xs text-muted-foreground/60')}>@forge generate Q3 analysis for all client datasets</p>
      </>
    ),
    caption:
      'State what you want in natural language. From a GitHub issue, a ticket, or any system with a webhook.',
  },
  {
    n: 2,
    title: 'Dispatch',
    panel: (
      <>
        <p className={cn(mono, 'text-xs text-lime-400')}>1 mission &rarr; 200 agents</p>
        <p className={cn(mono, 'mt-2 text-xs text-muted-foreground')}>
          Each agent gets tools, context, and a budget.
          <br />
          Concurrency-controlled.
          <br />
          <span className="text-foreground/80">Claude, GPT, Gemini, or Codex.</span>
        </p>
      </>
    ),
    caption:
      'Forge dispatches agents in parallel — one per unit of work. Each runs in a sandboxed environment with the tools it needs.',
  },
  {
    n: 3,
    title: 'Review',
    panel: (
      <>
        <p className={cn(mono, 'text-xs text-lime-400')}>200 artifacts ready for review</p>
        <p className={cn(mono, 'mt-2 text-xs text-muted-foreground')}>
          PRs, reports, drafts, redlines —
          <br />
          whatever the domain produces.
        </p>
        <p className={cn(mono, 'mt-1 text-xs text-lime-400')}>Human approves. Forge ships.</p>
      </>
    ),
    caption:
      'Every output is a reviewable artifact. You approve what ships. Full audit trail of what every agent did, and what it cost.',
  },
];

const loops = [
  {
    title: 'Loops that halt',
    desc: 'Max-turn caps, no-progress detection, and budget ceilings — enforced by the runtime, not the model’s good intentions.',
  },
  {
    title: 'Loops that check their own work',
    desc: 'Acceptance criteria gate every artifact before it ships. Self-verification is policy, set per skill — not a promise in a prompt.',
  },
  {
    title: 'Loops that compound',
    desc: 'Policy and method live in versioned skills, not prompts. Improve the skill once and every mission that uses it improves.',
  },
];

const domains = [
  {
    title: 'Software engineering',
    live: true,
    desc: 'PRs from GitHub issues. Fleet migrations. Self-healing CI. Dependency bumps across hundreds of repos.',
  },
  {
    title: 'Content ops',
    live: false,
    desc: 'Localize 50 blog posts. Generate product descriptions from specs. Draft campaigns from a brief. Editor reviews, not prompt sessions.',
  },
  {
    title: 'Data & analysis',
    live: false,
    desc: 'Run the same analysis across 30 client datasets. Each agent produces a report. Analyst spot-checks, doesn’t start from scratch.',
  },
  {
    title: 'Compliance & legal',
    live: false,
    desc: 'Review 200 vendor contracts against updated policy. Flag clauses. Suggest redlines. Legal reviews the output, not the whole stack.',
  },
];

const valueProps = [
  {
    word: 'Auditable.',
    problem:
      'Most agent platforms don’t log what happened across your fleet. You find out something went wrong when someone reports it.',
    fix: 'Forge records every action, every state change, every tool call — in a ledger you own.',
  },
  {
    word: 'Budgeted.',
    problem:
      'The expensive part isn’t the model anymore — it’s the loop running it. Alerts after the fact don’t work.',
    fix: 'Forge caps spend per mission and auto-pauses at 80%. The loop terminates at the ceiling — it doesn’t email you about it.',
  },
  {
    word: 'Portable.',
    problem: 'Locked into one model provider? Switch costs are high and growing.',
    fix: 'Forge runs Claude, GPT, Gemini, and Codex. Swap engines with one setting. No lock-in.',
  },
];

const skillPolicy = `loopPolicy:
  maxTurns: 40
  noProgressTokens: 300000
  selfVerify: false
  acceptanceCriteria: |
    - The change implements the requested feature or fix.
    - pnpm -r typecheck and pnpm -r test pass.
    - Changes follow the repo conventions in AGENTS.md.`;

const quickstart = `git clone https://github.com/paulmeller/forge && cd forge
pnpm install
cp apps/web/.env.example apps/web/.env.local
cp apps/tick/.env.example apps/tick/.env.local
pnpm --filter @forge/db db:generate
pnpm --filter @forge/db db:migrate
pnpm dev`;

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-background text-muted-foreground">
      {/* ── Hero ── */}
      <section className="pb-12 pt-28 md:pb-20 md:pt-40">
        <div className="mx-auto max-w-[1000px] px-4 text-center md:px-10">
          <h1 className={cn(display, 'mb-5 text-[clamp(40px,9vw,110px)] leading-[0.85] tracking-tight text-foreground md:mb-7')}>
            Backlogs in.
            <br />
            <span className={gradientText}>Results out.</span>
          </h1>
          <p className="mx-auto mb-4 max-w-[680px] text-base leading-relaxed text-muted-foreground md:text-xl">
            Forge is an open-source orchestrator that turns GitHub issues into
            fleets of sandboxed coding agents — dispatched in parallel, capped
            by budget, every action in an audit ledger you own.
          </p>
          <p className="mx-auto mb-8 max-w-[520px] text-sm leading-relaxed text-muted-foreground/60 md:text-base">
            Stripe merges 1,000+ autonomous PRs a week on internal
            infrastructure. Forge is that pattern, MIT-licensed.
          </p>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-primary px-6 text-base font-medium text-primary-foreground transition-all hover:brightness-90 sm:w-auto"
            >
              Get Started Free
            </Link>
            <Link
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-foreground/20 px-6 text-base font-medium text-foreground transition-all hover:border-foreground/30 hover:bg-foreground/5 sm:w-auto"
            >
              View on GitHub
            </Link>
          </div>
        </div>
      </section>

      {/* ── The pattern ── */}
      <section className="bg-muted/50">
        <div className="mx-auto max-w-[1000px] px-4 py-12 md:px-10 md:py-20">
          <h2 className={cn(h2, 'mb-4')}>
            One pattern. <span className={gradientText}>Any domain.</span>
          </h2>
          <p className="mb-10 max-w-[640px] text-base leading-relaxed text-muted-foreground md:text-xl">
            Describe intent. Agents do the work. You review the output. The
            pattern is the same whether the artifact is a pull request, a
            report, a contract, or a campaign.
          </p>

          <div className="grid gap-10 md:grid-cols-3 md:gap-6">
            {steps.map((s) => (
              <div key={s.n}>
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[oklch(0.93_0.26_110)] to-[oklch(0.90_0.29_132)] text-xs font-bold text-black">
                    {s.n}
                  </span>
                  <span className="text-base font-semibold text-foreground">{s.title}</span>
                </div>
                <div className="mb-3 rounded-xl bg-background p-4 ring-1 ring-border">{s.panel}</div>
                <p className="text-[13px] leading-relaxed text-muted-foreground/80">{s.caption}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Loops ── */}
      <section>
        <div className="mx-auto max-w-[1000px] px-4 py-12 md:px-10 md:py-20">
          <h2 className={cn(h2, 'mb-4')}>
            Stop prompting agents. <span className={gradientText}>Start designing loops.</span>
          </h2>
          <p className="mb-10 max-w-[640px] text-base leading-relaxed text-muted-foreground md:text-xl">
            A mission is a loop: it prompts the agents, checks the work, and
            decides whether to keep going. Without stopping conditions, loops
            run away — with them, they ship. You write the intent and the
            limits. Forge enforces them.
          </p>

          <div className="grid gap-3 md:grid-cols-3">
            {loops.map((l) => (
              <div key={l.title} className="rounded-xl bg-muted p-5">
                <h3 className="mb-2 text-sm font-semibold text-foreground">{l.title}</h3>
                <p className="text-[13px] leading-relaxed text-muted-foreground">{l.desc}</p>
              </div>
            ))}
          </div>

          <div className="mx-auto mt-10 max-w-[640px]">
            <div className="overflow-hidden rounded-xl bg-muted ring-1 ring-border">
              <div className="border-b border-border px-4 py-3 md:px-6">
                <span className={cn(mono, 'text-xs uppercase tracking-widest text-muted-foreground/40')}>
                  skills/forge-dev/SKILL.md
                </span>
              </div>
              <pre className={cn(mono, 'overflow-x-auto whitespace-pre px-4 py-4 text-[13px] leading-[1.8] text-muted-foreground md:px-6')}>
                {skillPolicy}
              </pre>
            </div>
            <p className="mt-3 text-center text-[13px] leading-relaxed text-muted-foreground/60">
              Real policy from the Forge skill library. Guardrails ship in the
              skill, not the prompt.
            </p>
          </div>
        </div>
      </section>

      {/* ── Domains ── */}
      <section className="bg-muted/50">
        <div className="mx-auto max-w-[1000px] px-4 py-12 md:px-10 md:py-20">
          <h2 className={cn(h2, 'mb-4')}>
            Shipping code today. <span className={gradientText}>Everything else tomorrow.</span>
          </h2>
          <p className="mb-10 max-w-[640px] text-base leading-relaxed text-muted-foreground md:text-xl">
            The agent doesn&rsquo;t know it&rsquo;s writing code. It&rsquo;s
            following instructions with tools. Change the tools, change the
            domain.
          </p>

          <div className="grid gap-3 md:grid-cols-2">
            {domains.map((d) => (
              <div
                key={d.title}
                className={cn(
                  'rounded-xl p-5',
                  d.live ? 'bg-background ring-1 ring-lime-400/30' : 'bg-background/60 ring-1 ring-border',
                )}
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className={cn('size-1.5 rounded-full', d.live ? 'bg-lime-400' : 'bg-muted-foreground/30')} />
                  <h3 className={cn('text-base font-semibold', d.live ? 'text-foreground' : 'text-muted-foreground')}>
                    {d.title}
                  </h3>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
                      d.live ? 'bg-lime-400/10 text-lime-400' : 'bg-muted text-muted-foreground/60',
                    )}
                  >
                    {d.live ? 'Live now' : 'Coming'}
                  </span>
                </div>
                <p className={cn('text-[13px] leading-relaxed', d.live ? 'text-muted-foreground' : 'text-muted-foreground/60')}>
                  {d.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── The wow — self-healing CI ── */}
      <section>
        <div className="mx-auto max-w-[1000px] px-4 py-12 md:px-10 md:py-20">
          <div className="mx-auto max-w-[640px]">
            <h2 className={cn(h2, 'mb-4')}>
              CI fails. <span className={gradientText}>Forge fixes it.</span>
            </h2>
            <p className="mb-6 text-base leading-relaxed text-muted-foreground md:text-xl">
              When a check suite fails on a pull request, Forge automatically
              dispatches an agent to read the logs, fix the code, and push. No
              command needed. No human in the loop.
            </p>
            <div className="rounded-xl bg-muted p-5 ring-1 ring-border">
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-red-500" />
                <span className={cn(mono, 'text-xs text-foreground')}>CI failed on PR #187</span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="size-2 rounded-full bg-amber-400" />
                <span className={cn(mono, 'text-xs text-muted-foreground')}>Forge agent dispatched automatically</span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="size-2 rounded-full bg-lime-400 shadow-[0_0_8px_2px_rgba(163,230,53,0.4)]" />
                <span className={cn(mono, 'text-xs text-muted-foreground')}>Fix pushed. CI passing.</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Scale — one mission, any scale ── */}
      <section className="bg-muted/50">
        <div className="mx-auto max-w-[1000px] px-4 py-12 md:px-10 md:py-20">
          <h2 className={cn(h2, 'mb-8 text-center')}>
            One mission. <span className={gradientText}>Any scale.</span>
          </h2>
          <div className="flex items-center justify-center" style={{ minHeight: '4rem' }}>
            <RotatingMissions />
          </div>
          <p className="mx-auto mt-6 max-w-[520px] text-center text-sm leading-relaxed text-muted-foreground/60">
            One command spawns hundreds of agents. Each works in a sandboxed
            environment with the tools it needs. Concurrency-controlled.
            Budget-capped. Every action in a ledger you own.
          </p>
        </div>
      </section>

      {/* ── Value props ── */}
      <section>
        <div className="mx-auto max-w-[1000px] px-4 py-12 md:px-10 md:py-20">
          <div className="flex flex-col gap-10">
            {valueProps.map((v) => (
              <div key={v.word}>
                <span className={cn(display, 'text-[clamp(1.75rem,4vw,2.5rem)] leading-[0.9]')}>
                  <span className={gradientText}>{v.word}</span>
                </span>
                <p className="mt-2 max-w-[760px] text-base leading-relaxed text-muted-foreground md:text-lg">
                  {v.problem} <span className="text-foreground">{v.fix}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Why open source ── */}
      <section className="bg-muted/50">
        <div className="mx-auto max-w-[1000px] px-4 py-12 md:px-10 md:py-20">
          <h2 className={cn(h2, 'mb-6')}>
            Why <span className={gradientText}>open source.</span>
          </h2>
          <div className="flex max-w-[760px] flex-col gap-4 text-base leading-relaxed md:text-xl">
            <p>
              Stripe&rsquo;s internal{' '}
              <a
                href="https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors hover:decoration-foreground"
              >
                Minions system
              </a>{' '}
              merges over a thousand autonomous PRs a week. It took a dedicated
              infrastructure team to build. That capability shouldn&rsquo;t
              require a $200/mo subscription and a proprietary black box.
            </p>
            <p className="font-medium text-foreground">
              Forge is MIT-licensed. Self-host the engine, or use the managed
              service. The orchestration layer is open. The agents are
              world-class.
            </p>
          </div>
          <blockquote className="mt-8 max-w-[640px] border-l-2 border-lime-400/40 pl-4">
            <p className={cn(mono, 'text-[13px] italic leading-relaxed text-muted-foreground')}>
              &ldquo;Over a thousand pull requests merged each week at Stripe
              are completely minion-produced, and while they&rsquo;re
              human-reviewed, they contain no human-written code.&rdquo;
            </p>
            <cite className="mt-1.5 block text-xs not-italic text-muted-foreground/60">
              — Stripe Engineering, on Minions
            </cite>
          </blockquote>
        </div>
      </section>

      {/* ── Quickstart ── */}
      <section>
        <div className="mx-auto max-w-[1000px] px-4 py-12 md:px-10 md:py-20">
          <div className="mx-auto max-w-[640px]">
            <h2 className={cn(h2, 'mb-4')}>
              Self-host it <span className={gradientText}>tonight.</span>
            </h2>
            <p className="mb-6 text-base leading-relaxed text-muted-foreground md:text-xl">
              Node 22 and pnpm 10. No Forge account required — bring your own
              Anthropic API key. The managed service is optional.
            </p>
            <div className="overflow-hidden rounded-xl bg-muted ring-1 ring-border">
              <div className="border-b border-border px-4 py-3 md:px-6">
                <span className={cn(mono, 'text-xs uppercase tracking-widest text-muted-foreground/40')}>Terminal</span>
              </div>
              <pre className={cn(mono, 'overflow-x-auto whitespace-pre px-4 py-4 text-[13px] leading-[1.8] text-muted-foreground md:px-6')}>
                {quickstart}
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA — always dark text since background is the lime gradient ── */}
      <div className="bg-gradient-to-b from-[oklch(0.93_0.26_110)] to-[oklch(0.90_0.29_132)]">
        <div className="mx-auto flex max-w-[1000px] flex-col items-center px-4 py-16 text-center md:px-10 md:py-24">
          <h2 className={cn(display, 'mb-5 text-[clamp(2rem,5vw,3.5rem)] leading-[0.9] text-black')}>
            Start a mission.
          </h2>
          <p className="mb-8 max-w-[520px] text-base leading-relaxed text-black/60 md:text-xl">
            First result in under 10 minutes. MIT licensed. Free to use.
          </p>
          <div className="flex w-full flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-black px-6 text-base font-medium text-white transition-all hover:bg-black/85 sm:w-auto"
            >
              Get Started Free
            </Link>
            <Link
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-black/20 px-6 text-base font-medium text-black transition-all hover:border-black/30 hover:bg-black/5 sm:w-auto"
            >
              Star on GitHub
            </Link>
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <footer className="bg-neutral-950 text-neutral-400">
        <div className="px-6 pb-8 pt-10 sm:px-10 md:pt-16">
          <div className="flex flex-col items-start justify-between gap-8 md:flex-row">
            <div>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-lime-400 shadow-[0_0_8px_2px_rgba(163,230,53,0.6)]" />
                <span className="font-mono text-[15px] font-semibold tracking-tight text-white">forge</span>
              </span>
              <p className="mt-3 text-sm leading-relaxed text-neutral-500">
                Open-source Missions for Managed Agents.
                <br />
                MIT License.
              </p>
            </div>
            <div className="flex gap-6 text-sm">
              <Link href="/docs" className="text-neutral-500 transition-colors hover:text-lime-400">
                Docs
              </Link>
              <Link href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="text-neutral-500 transition-colors hover:text-lime-400">
                GitHub
              </Link>
              <Link href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener noreferrer" className="text-neutral-500 transition-colors hover:text-lime-400">
                Issues
              </Link>
              <Link href="/login" className="text-neutral-500 transition-colors hover:text-lime-400">
                Log in
              </Link>
            </div>
          </div>
          <p className="mt-8 text-xs text-neutral-600">
            &copy; 2026 Forge. MIT License. Product names and logos are
            trademarks of their respective owners.
          </p>
        </div>
      </footer>
    </main>
  );
}
