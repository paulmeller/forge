import Link from 'next/link';

const GITHUB_URL = 'https://github.com/paulmeller/forge';

const useCases = [
  {
    title: 'Fleet migrations',
    desc: 'Bump a dependency across 200 repos. One mission, 200 agents, 200 PRs.',
    example: '@forge bump fast-glob to ^3.3.2',
  },
  {
    title: 'Self-healing CI',
    desc: 'CI fails on a PR? Forge auto-dispatches an agent to fix it and push.',
    example: 'Automatic — no command needed',
  },
  {
    title: 'Backlog autopilot',
    desc: 'Point Forge at your issues. It reads the spec, codes the fix, opens a PR.',
    example: '@forge implement this',
  },
] as const;

export default function LandingPage() {
  return (
    <main>
      {/* Hero */}
      <section className="mx-auto max-w-[960px] px-6 pb-24 pt-24 md:px-12">
        <div className="mx-auto max-w-[680px] text-center">
          <span className="mb-5 inline-block rounded-full border border-[#27272a] bg-[#18181b] px-3 py-1 text-[11px] uppercase tracking-wider text-[#a1a1aa]">
            Free during beta
          </span>
          <h1 className="mb-6 text-[40px] font-semibold leading-[1.05] tracking-[-2px] md:text-[64px]">
            GitHub Issues in.
            <br />
            Pull Requests out.
          </h1>
          <p className="mx-auto mb-10 max-w-[480px] text-[18px] leading-relaxed text-[#71717a]">
            Connect your repos. Comment{' '}
            <code className="rounded bg-[#18181b] px-1.5 py-0.5 text-[15px] text-[#a1a1aa]">
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

      {/* Use cases */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        <h2 className="mb-4 text-center text-2xl font-semibold tracking-tight">
          One command. Any scale.
        </h2>
        <p className="mb-14 text-center text-sm text-[#71717a]">
          From a single fix to a fleet-wide migration.
        </p>
        <div className="grid gap-6 md:grid-cols-3">
          {useCases.map((uc) => (
            <div
              key={uc.title}
              className="rounded-lg border border-[#27272a] bg-[#18181b] p-6"
            >
              <h3 className="mb-2 text-base font-semibold">{uc.title}</h3>
              <p className="mb-4 text-[13px] leading-relaxed text-[#71717a]">
                {uc.desc}
              </p>
              <code className="text-xs text-[#52525b]">{uc.example}</code>
            </div>
          ))}
        </div>
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* Value props */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        {[
          [
            'Auditable.',
            'Every action, every state change, every dollar spent — in a ledger you own.',
          ],
          [
            'Budgeted.',
            'Cap spend per mission. Auto-pause at 80%. No fleet-wide cost surprises.',
          ],
          [
            'Portable.',
            'Claude, GPT, Gemini, Codex. Swap engines with one setting. No lock-in.',
          ],
        ].map(([word, desc]) => (
          <div key={word} className="mb-8 flex items-center gap-5 last:mb-0">
            <span className="shrink-0 text-[32px] font-semibold tracking-tight">
              {word}
            </span>
            <span className="text-[15px] leading-normal text-[#71717a]">
              {desc}
            </span>
          </div>
        ))}
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* Why open source */}
      <section className="mx-auto max-w-[960px] px-6 py-20 md:px-12">
        <h2 className="mb-6 text-2xl font-semibold tracking-tight">
          Why open source
        </h2>
        <div className="mb-6">
          <p className="mb-4 text-[15px] leading-relaxed">
            Stripe runs 1,300 autonomous PRs per week with an internal tool
            their engineers built. That capability shouldn&rsquo;t require a
            $200/mo subscription and a proprietary black box.
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
          Start shipping faster.
        </h2>
        <p className="mb-8 text-[15px] text-[#71717a]">
          Free during beta. No credit card. Connect in 30 seconds.
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
