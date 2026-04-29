import Link from 'next/link';

const GITHUB_URL = 'https://github.com/paulmeller/forge';

export default function LandingPage() {
  return (
    <main>
      {/* Hero */}
      <section className="mx-auto max-w-[960px] px-6 pb-24 pt-24 md:px-12">
        <div className="mx-auto max-w-[680px] text-center">
          <h1 className="mb-6 text-[40px] font-semibold leading-[1.05] tracking-[-2px] md:text-[64px]">
            GitHub Issues in.
            <br />
            Pull Requests out.
          </h1>
          <p className="mx-auto mb-4 max-w-[520px] text-[18px] leading-relaxed text-[#a1a1aa]">
            Stripe runs 1,300 autonomous PRs per week with an internal tool.
            Forge is that tool — open source.
          </p>
          <p className="mx-auto mb-10 max-w-[480px] text-[16px] leading-relaxed text-[#52525b]">
            Connect your repos. Comment{' '}
            <code className="rounded bg-[#18181b] px-1.5 py-0.5 text-[14px] text-[#a1a1aa]">
              @forge
            </code>{' '}
            on any issue. Get a pull request back.
          </p>
          <div className="flex justify-center gap-3">
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
          </div>
        </div>
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* How it works — three steps */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        <h2 className="mb-4 text-center text-2xl font-semibold tracking-tight">
          Three steps. That&rsquo;s it.
        </h2>
        <p className="mb-14 text-center text-sm text-[#71717a]">
          No CLI. No config files. Works from GitHub.
        </p>

        <div className="grid gap-10 md:grid-cols-3 md:gap-6">
          {/* Step 1 */}
          <div>
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#18181b] text-sm font-semibold text-[#a1a1aa]">
                1
              </span>
              <span className="text-base font-semibold">Connect</span>
            </div>
            <div className="mb-3 rounded-lg border border-[#27272a] bg-[#0f0f11] p-4">
              <p className="font-mono text-xs text-[#52525b]">
                <span className="text-[#3b82f6]">forge.dev/setup</span>
              </p>
              <p className="mt-2 font-mono text-xs text-[#71717a]">
                Sign in with GitHub.
                <br />
                Pick your repos.
                <br />
                <span className="text-[#22c55e]">Connected in 30 seconds.</span>
              </p>
            </div>
            <p className="text-[13px] leading-relaxed text-[#52525b]">
              Install the GitHub App. Select which repos Forge can access.
              Webhooks are configured automatically.
            </p>
          </div>

          {/* Step 2 */}
          <div>
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#18181b] text-sm font-semibold text-[#a1a1aa]">
                2
              </span>
              <span className="text-base font-semibold">Work</span>
            </div>
            <div className="mb-3 rounded-lg border border-[#27272a] bg-[#0f0f11] p-4">
              <p className="font-mono text-xs text-[#52525b]">
                <span className="text-[#a1a1aa]">paulmeller</span> commented:
              </p>
              <p className="mt-2 font-mono text-xs text-[#fafafa]">
                @forge add rate limiting to /api/users
              </p>
              <p className="mt-2 font-mono text-xs text-[#f59e0b]">
                Agent dispatched. Coding...
              </p>
            </div>
            <p className="text-[13px] leading-relaxed text-[#52525b]">
              Comment on any issue in your connected repos. An agent picks it
              up, reads the codebase, and starts coding.
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
                PR #234 opened
              </p>
              <p className="mt-2 font-mono text-xs text-[#71717a]">
                + 42 &nbsp;- 3 &nbsp;files changed: 2
              </p>
              <p className="mt-1 font-mono text-xs text-[#22c55e]">
                CI passing
              </p>
            </div>
            <p className="text-[13px] leading-relaxed text-[#52525b]">
              Get a pull request. CI runs automatically. Review code, not chat
              logs. Merge when ready.
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

      {/* Scale — one mission, hundreds of repos */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        <h2 className="mb-6 text-center text-2xl font-semibold tracking-tight">
          One mission. Hundreds of repos.
        </h2>
        <div className="flex items-center justify-center" style={{ minHeight: '4rem' }}>
          <p className="text-center text-[28px] font-medium leading-snug tracking-tight text-[#a1a1aa] md:text-[36px]">
            &ldquo;Migrate 200 services from Express to Fastify.&rdquo;
          </p>
        </div>
        <p className="mx-auto mt-6 max-w-[480px] text-center text-[14px] leading-relaxed text-[#52525b]">
          One command spawns 200 agents. Each clones a repo, makes the change,
          opens a PR. Concurrency-controlled. Budget-capped. Every action in a
          ledger you own.
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
            You find out something went wrong when a customer reports it.{' '}
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
            Agent APIs bill per session-hour with no cap. You discover what you
            spent after the fact.{' '}
            <span className="text-[#a1a1aa]">
              Forge caps spend per mission. Auto-pauses at 80%. You set the
              ceiling before the first agent starts.
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
          First PR in under 10 minutes. MIT licensed. Free to use.
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
