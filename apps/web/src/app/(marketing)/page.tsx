import Link from 'next/link';

import { RotatingMissions } from './_components/rotating-missions';

const GITHUB_URL = 'https://github.com/paulmeller/forge';

export default function LandingPage() {
  return (
    <main>
      {/* Hero */}
      <section className="mx-auto max-w-[960px] px-6 pb-24 pt-24 md:px-12">
        <div className="mx-auto max-w-[700px] text-center">
          <h1 className="mb-6 text-[40px] font-semibold leading-[1.05] tracking-[-2px] md:text-[64px]">
            Backlogs in.
            <br />
            Results out.
          </h1>
          <p className="mx-auto mb-4 max-w-[540px] text-[18px] leading-relaxed text-[#a1a1aa]">
            Forge is an open-source orchestrator that turns GitHub issues
            into fleets of sandboxed coding agents — dispatched in parallel,
            capped by budget, every action in an audit ledger you own.
          </p>
          <p className="mx-auto mb-10 max-w-[480px] text-[16px] leading-relaxed text-[#52525b]">
            Stripe merges 1,000+ autonomous PRs a week on internal
            infrastructure. Forge is that pattern, MIT-licensed.
          </p>
          <div className="flex justify-center gap-3">
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
          </div>
        </div>
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* The pattern */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        <h2 className="mb-4 text-center text-2xl font-semibold tracking-tight">
          One pattern. Any domain.
        </h2>
        <p className="mx-auto mb-14 max-w-[520px] text-center text-sm text-[#71717a]">
          Describe intent. Agents do the work. You review the output. The
          pattern is the same whether the artifact is a pull request, a report,
          a contract, or a campaign.
        </p>

        <div className="grid gap-10 md:grid-cols-3 md:gap-6">
          {/* Step 1 */}
          <div>
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#18181b] text-sm font-semibold text-[#a1a1aa]">
                1
              </span>
              <span className="text-base font-semibold">Describe</span>
            </div>
            <div className="mb-3 rounded-lg border border-[#27272a] bg-[#0f0f11] p-4">
              <p className="font-mono text-xs text-[#52525b]">
                Issue, ticket, or brief:
              </p>
              <p className="mt-2 font-mono text-xs text-[#fafafa]">
                @forge add rate limiting to /api/users
              </p>
              <p className="mt-1 font-mono text-xs text-[#52525b]">
                @forge review this contract against our new policy
              </p>
              <p className="mt-1 font-mono text-xs text-[#52525b]">
                @forge generate Q3 analysis for all client datasets
              </p>
            </div>
            <p className="text-[13px] leading-relaxed text-[#52525b]">
              State what you want in natural language. From a GitHub issue, a
              ticket, or any system with a webhook.
            </p>
          </div>

          {/* Step 2 */}
          <div>
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#18181b] text-sm font-semibold text-[#a1a1aa]">
                2
              </span>
              <span className="text-base font-semibold">Dispatch</span>
            </div>
            <div className="mb-3 rounded-lg border border-[#27272a] bg-[#0f0f11] p-4">
              <p className="font-mono text-xs text-[#f59e0b]">
                1 mission → 200 agents
              </p>
              <p className="mt-2 font-mono text-xs text-[#71717a]">
                Each agent gets tools, context, and a budget.
                <br />
                Concurrency-controlled.
                <br />
                <span className="text-[#a1a1aa]">Claude, GPT, Gemini, or Codex.</span>
              </p>
            </div>
            <p className="text-[13px] leading-relaxed text-[#52525b]">
              Forge dispatches agents in parallel — one per unit of work. Each
              runs in a sandboxed environment with the tools it needs.
            </p>
          </div>

          {/* Step 3 */}
          <div>
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#18181b] text-sm font-semibold text-[#a1a1aa]">
                3
              </span>
              <span className="text-base font-semibold">Review</span>
            </div>
            <div className="mb-3 rounded-lg border border-[#27272a] bg-[#0f0f11] p-4">
              <p className="font-mono text-xs text-[#22c55e]">
                200 artifacts ready for review
              </p>
              <p className="mt-2 font-mono text-xs text-[#71717a]">
                PRs, reports, drafts, redlines —
                <br />
                whatever the domain produces.
              </p>
              <p className="mt-1 font-mono text-xs text-[#22c55e]">
                Human approves. Forge ships.
              </p>
            </div>
            <p className="text-[13px] leading-relaxed text-[#52525b]">
              Every output is a reviewable artifact. You approve what ships.
              Full audit trail of what every agent did, and what it cost.
            </p>
          </div>
        </div>
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* Loops */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        <h2 className="mb-4 text-center text-2xl font-semibold tracking-tight">
          Stop prompting agents. Start designing loops.
        </h2>
        <p className="mx-auto mb-14 max-w-[560px] text-center text-sm text-[#71717a]">
          A mission is a loop: it prompts the agents, checks the work, and
          decides whether to keep going. Without stopping conditions, loops
          run away — with them, they ship. You write the intent and the
          limits. Forge enforces them.
        </p>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-[#27272a] bg-[#18181b] p-6">
            <h3 className="mb-2 text-base font-semibold">Loops that halt</h3>
            <p className="text-[13px] leading-relaxed text-[#71717a]">
              Max-turn caps, no-progress detection, and budget ceilings —
              enforced by the runtime, not the model&rsquo;s good intentions.
            </p>
          </div>
          <div className="rounded-lg border border-[#27272a] bg-[#18181b] p-6">
            <h3 className="mb-2 text-base font-semibold">
              Loops that check their own work
            </h3>
            <p className="text-[13px] leading-relaxed text-[#71717a]">
              Acceptance criteria and self-verification gates before any
              artifact is marked done.
            </p>
          </div>
          <div className="rounded-lg border border-[#27272a] bg-[#18181b] p-6">
            <h3 className="mb-2 text-base font-semibold">
              Loops that compound
            </h3>
            <p className="text-[13px] leading-relaxed text-[#71717a]">
              Policy and method live in versioned skills, not prompts. Every
              mission that runs a skill makes the next one cheaper.
            </p>
          </div>
        </div>

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
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* Domains */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        <h2 className="mb-4 text-center text-2xl font-semibold tracking-tight">
          Shipping code today. Everything else tomorrow.
        </h2>
        <p className="mx-auto mb-14 max-w-[480px] text-center text-sm text-[#71717a]">
          The agent doesn&rsquo;t know it&rsquo;s writing code. It&rsquo;s
          following instructions with tools. Change the tools, change the domain.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-[#27272a] bg-[#18181b] p-6">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[#22c55e]">*</span>
              <h3 className="text-base font-semibold">Software engineering</h3>
              <span className="rounded-full bg-[#22c55e]/10 px-2 py-0.5 text-[10px] font-medium text-[#22c55e]">
                Live now
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-[#71717a]">
              PRs from GitHub issues. Fleet migrations. Self-healing CI.
              Dependency bumps across hundreds of repos.
            </p>
          </div>
          <div className="rounded-lg border border-[#1a1a1e] bg-[#0f0f11] p-6">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[#52525b]">*</span>
              <h3 className="text-base font-semibold text-[#a1a1aa]">Content ops</h3>
              <span className="rounded-full bg-[#27272a] px-2 py-0.5 text-[10px] font-medium text-[#52525b]">
                Coming
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-[#52525b]">
              Localize 50 blog posts. Generate product descriptions from specs.
              Draft campaigns from a brief. Editor reviews, not prompt sessions.
            </p>
          </div>
          <div className="rounded-lg border border-[#1a1a1e] bg-[#0f0f11] p-6">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[#52525b]">*</span>
              <h3 className="text-base font-semibold text-[#a1a1aa]">Data &amp; analysis</h3>
              <span className="rounded-full bg-[#27272a] px-2 py-0.5 text-[10px] font-medium text-[#52525b]">
                Coming
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-[#52525b]">
              Run the same analysis across 30 client datasets. Each agent
              produces a report. Analyst spot-checks, doesn&rsquo;t start from scratch.
            </p>
          </div>
          <div className="rounded-lg border border-[#1a1a1e] bg-[#0f0f11] p-6">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[#52525b]">*</span>
              <h3 className="text-base font-semibold text-[#a1a1aa]">Compliance &amp; legal</h3>
              <span className="rounded-full bg-[#27272a] px-2 py-0.5 text-[10px] font-medium text-[#52525b]">
                Coming
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-[#52525b]">
              Review 200 vendor contracts against updated policy. Flag clauses.
              Suggest redlines. Legal reviews the output, not the whole stack.
            </p>
          </div>
        </div>
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* The wow — self-healing CI */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        <div className="mx-auto max-w-[600px]">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            CI fails. Forge fixes it.
          </h2>
          <p className="mb-6 text-[15px] leading-relaxed text-[#71717a]">
            When a check suite fails on a pull request, Forge automatically
            dispatches an agent to read the logs, fix the code, and push.
            No command needed. No human in the loop.
          </p>
          <div className="rounded-lg border border-[#27272a] bg-[#0f0f11] p-5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-red-500" />
              <span className="font-mono text-xs text-[#a1a1aa]">
                CI failed on PR #187
              </span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#f59e0b]" />
              <span className="font-mono text-xs text-[#71717a]">
                Forge agent dispatched automatically
              </span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#22c55e]" />
              <span className="font-mono text-xs text-[#71717a]">
                Fix pushed. CI passing.
              </span>
            </div>
          </div>
        </div>
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* Scale — one mission, any scale */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        <h2 className="mb-6 text-center text-2xl font-semibold tracking-tight">
          One mission. Any scale.
        </h2>
        <div className="flex items-center justify-center" style={{ minHeight: '4rem' }}>
          <RotatingMissions />
        </div>
        <p className="mx-auto mt-6 max-w-[480px] text-center text-[14px] leading-relaxed text-[#52525b]">
          One command spawns hundreds of agents. Each works in a sandboxed
          environment with the tools it needs. Concurrency-controlled.
          Budget-capped. Every action in a ledger you own.
        </p>
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* Value props — with contrast */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        <div className="mb-10">
          <span className="text-[32px] font-semibold tracking-tight">
            Auditable.
          </span>
          <p className="mt-2 text-[15px] leading-relaxed text-[#71717a]">
            Most agent platforms don&rsquo;t log what happened across your fleet.
            You find out something went wrong when someone reports it.{' '}
            <span className="text-[#a1a1aa]">
              Forge records every action, every state change, every tool call —
              in a ledger you own.
            </span>
          </p>
        </div>
        <div className="mb-10">
          <span className="text-[32px] font-semibold tracking-tight">
            Budgeted.
          </span>
          <p className="mt-2 text-[15px] leading-relaxed text-[#71717a]">
            The expensive part isn&rsquo;t the model anymore — it&rsquo;s the
            loop running it. Alerts after the fact don&rsquo;t work.{' '}
            <span className="text-[#a1a1aa]">
              Forge caps spend per mission and auto-pauses at 80%. The loop
              terminates at the ceiling — it doesn&rsquo;t email you about it.
            </span>
          </p>
        </div>
        <div>
          <span className="text-[32px] font-semibold tracking-tight">
            Portable.
          </span>
          <p className="mt-2 text-[15px] leading-relaxed text-[#71717a]">
            Locked into one model provider? Switch costs are high and growing.{' '}
            <span className="text-[#a1a1aa]">
              Forge runs Claude, GPT, Gemini, and Codex. Swap engines with one
              setting. No lock-in.
            </span>
          </p>
        </div>
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* Why open source */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        <h2 className="mb-6 text-2xl font-semibold tracking-tight">
          Why open source
        </h2>
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
      </section>

      <hr className="border-[#1a1a1e]" />

      {/* Footer CTA */}
      <section className="px-6 py-24 text-center md:px-12">
        <h2 className="mb-3 text-4xl font-semibold tracking-tight">
          Start a Mission.
        </h2>
        <p className="mb-8 text-[15px] text-[#71717a]">
          First result in under 10 minutes. MIT licensed. Free to use.
        </p>
        <div className="flex justify-center gap-3">
          <Link
            href="/signup"
            className="rounded-md bg-[#fafafa] px-6 py-3 text-sm font-medium text-[#09090b] transition-colors hover:bg-[#e4e4e7]"
          >
            Get Started Free
          </Link>
          <Link
            href={GITHUB_URL}
            className="rounded-md border border-[#27272a] px-6 py-3 text-sm text-[#a1a1aa] transition-colors hover:border-[#3f3f46] hover:text-[#d4d4d8]"
          >
            Star on GitHub
          </Link>
        </div>
      </section>

      {/* Bottom Bar */}
      <div className="flex items-center justify-between border-t border-[#1a1a1e] px-6 py-5 md:px-12">
        <span className="text-xs text-[#52525b]">MIT License · Forge</span>
        <div className="flex gap-4">
          <Link
            href="/docs"
            className="text-xs text-[#52525b] transition-colors hover:text-[#71717a]"
          >
            Docs
          </Link>
          <Link
            href={GITHUB_URL}
            className="text-xs text-[#52525b] transition-colors hover:text-[#71717a]"
          >
            GitHub
          </Link>
        </div>
      </div>
    </main>
  );
}
