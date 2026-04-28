import Link from 'next/link';

import { ConsoleMock } from './_components/console-mock';

const GITHUB_URL = 'https://github.com/anthropics/forge';

const steps = [
  { num: 1, name: 'Plan', desc: 'Define target repos.\nPreview tasks.\nSet budget.' },
  { num: 2, name: 'Dispatch', desc: 'Parallel agent sessions.\nOne per repo.\nConcurrency-controlled.' },
  { num: 3, name: 'Gate', desc: 'Open PRs.\nWait for CI.\nRetry on failure.' },
  { num: 4, name: 'Merge', desc: 'Auto-merge on pass.\nFlag for review.\nTrack in Ledger.' },
] as const;

export default function LandingPage() {
  return (
    <main>
      {/* Hero */}
      <section className="mx-auto flex max-w-[960px] items-start justify-between gap-12 px-12 pb-20 pt-20">
        <div className="flex-1">
          <span className="mb-4 inline-block rounded-full border border-[#27272a] px-2.5 py-1 text-[11px] uppercase tracking-wide text-[#a1a1aa]">
            Built on Claude Managed Agents
          </span>
          <h1 className="mb-5 text-[52px] font-semibold leading-[1.08] tracking-[-1.5px]">
            Fleet orchestration
            <br />
            for Claude
            <br />
            Managed Agents.
          </h1>
          <p className="mb-8 max-w-[440px] text-[17px] leading-relaxed text-[#71717a]">
            Plan missions. Dispatch agents in parallel. Gate on CI. Auto-merge.
            Track every dollar.
          </p>
          <div className="flex gap-3">
            <Link
              href={GITHUB_URL}
              className="rounded-md bg-[#fafafa] px-5 py-2.5 text-sm font-medium text-[#09090b] transition-colors hover:bg-[#e4e4e7]"
            >
              ★ Star on GitHub
            </Link>
            <Link
              href="/docs/quickstart"
              className="rounded-md border border-[#27272a] px-5 py-2.5 text-sm text-[#a1a1aa] transition-colors hover:border-[#3f3f46] hover:text-[#d4d4d8]"
            >
              Quickstart →
            </Link>
          </div>
        </div>
        <ConsoleMock />
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* Value Props */}
      <section className="mx-auto max-w-[960px] px-12 py-[72px]">
        {[
          ['Auditable.', 'Managed Agents doesn\u2019t log what happened across your fleet. Forge does. Every action, every state change, in a ledger you own.'],
          ['Budgeted.', 'CMA bills per session-hour. Forge caps spend per mission. Auto-pause at 80%. No fleet-wide cost surprises.'],
          ['Portable.', 'Claude Managed Agents today. Self-hosted gateway tomorrow. Swap with one env var. No lock-in.'],
        ].map(([word, desc]) => (
          <div key={word} className="mb-8 flex items-baseline gap-5 last:mb-0">
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

      {/* Where Forge Fits */}
      <section className="mx-auto max-w-[960px] px-12 py-[72px]">
        <h2 className="mb-2 text-center text-2xl font-semibold tracking-tight">
          Where Forge fits
        </h2>
        <p className="mb-10 text-center text-sm text-[#71717a]">
          Managed Agents runs the agent. Forge runs the fleet.
        </p>
        <div className="mx-auto flex max-w-[520px] flex-col gap-2">
          <div className="rounded-lg bg-[#1a1a1e] px-6 py-4">
            <div className="mb-1 text-[10px] uppercase tracking-widest text-[#52525b]">
              You
            </div>
            <p className="text-sm text-[#71717a]">
              &ldquo;Bump fast-glob across 140 repos&rdquo;
            </p>
          </div>
          <div className="rounded-lg border border-[#3f3f46] bg-[#18181b] px-6 py-4">
            <div className="mb-1 text-[10px] uppercase tracking-widest text-[#a1a1aa]">
              Forge
            </div>
            <p className="text-sm text-[#fafafa]">
              Plan → Dispatch → Gate → Merge
            </p>
          </div>
          <div className="rounded-lg bg-[#1a1a1e] px-6 py-4">
            <div className="mb-1 text-[10px] uppercase tracking-widest text-[#52525b]">
              Claude Managed Agents
            </div>
            <p className="text-sm text-[#71717a]">
              Single agent, single container, single task
            </p>
          </div>
        </div>
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* How a Mission Runs */}
      <section className="mx-auto max-w-[960px] px-12 py-[72px]">
        <h2 className="mb-2 text-center text-2xl font-semibold tracking-tight">
          How a Mission runs
        </h2>
        <p className="mb-10 text-center text-sm text-[#71717a]">
          &ldquo;Bump fast-glob to ^3.3.2 across 140 repos&rdquo;
        </p>
        <div className="flex items-start gap-3">
          {steps.map((step, i) => (
            <div key={step.name} className="contents">
              <div className="flex-1 text-center">
                <div className="mb-2.5 rounded-lg border border-[#27272a] bg-[#18181b] px-3 py-[18px]">
                  <div className="mb-1 text-lg font-semibold text-[#52525b]">
                    {step.num}
                  </div>
                  <div className="text-sm font-semibold">{step.name}</div>
                </div>
                <p className="whitespace-pre-line text-[11px] leading-snug text-[#52525b]">
                  {step.desc}
                </p>
              </div>
              {i < steps.length - 1 && (
                <span className="mt-7 shrink-0 text-xl text-[#27272a]">→</span>
              )}
            </div>
          ))}
        </div>
      </section>

      <hr className="mx-auto max-w-[960px] border-[#1a1a1e]" />

      {/* Why Open Source */}
      <section className="mx-auto max-w-[960px] px-12 py-[72px]">
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
            Forge is MIT-licensed fleet orchestration built on Anthropic&rsquo;s
            Managed Agents API. The engine is world-class. Forge is the fleet
            management system it was missing.
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
      <section className="px-12 py-20 text-center">
        <h2 className="mb-3 text-4xl font-semibold tracking-tight">
          Start a Mission.
        </h2>
        <p className="mb-8 text-[15px] text-[#71717a]">
          First Mission running in under 10 minutes. MIT licensed. Free forever.
        </p>
        <div className="flex justify-center gap-3">
          <Link
            href={GITHUB_URL}
            className="rounded-md bg-[#fafafa] px-6 py-3 text-sm font-medium text-[#09090b] transition-colors hover:bg-[#e4e4e7]"
          >
            ★ Star on GitHub
          </Link>
          <Link
            href="/docs/quickstart"
            className="rounded-md border border-[#27272a] px-6 py-3 text-sm text-[#a1a1aa] transition-colors hover:border-[#3f3f46] hover:text-[#d4d4d8]"
          >
            Quickstart →
          </Link>
        </div>
      </section>

      {/* Bottom Bar */}
      <div className="flex items-center justify-between border-t border-[#1a1a1e] px-12 py-5">
        <span className="text-xs text-[#52525b]">MIT License · Forge</span>
        <Link
          href={GITHUB_URL}
          className="text-xs text-[#52525b] transition-colors hover:text-[#71717a]"
        >
          GitHub
        </Link>
      </div>
    </main>
  );
}
