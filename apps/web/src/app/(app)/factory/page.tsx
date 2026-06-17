import Link from 'next/link';

import { getFactoryData } from '@/lib/factory';
import { getOptionalUser } from '@/lib/with-auth';
import { LiveControl } from '@/components/factory/live-control';
import { MetricCard } from '@/components/factory/metric-card';
import { SonarGauge } from '@/components/factory/sonar-gauge';
import { StageStrip } from '@/components/factory/stage-strip';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Software Factory · Forge',
};

export default async function FactoryPage() {
  const user = await getOptionalUser();
  const userId = user?.id ?? 'user_default';
  const data = await getFactoryData(userId);

  // Normalise 24h activity into a 0–1 intensity for the sonar blip density.
  const signalActivity = Math.min(1, data.signal.throughput24h / 40);
  const deployActivity = Math.min(1, data.deploy.throughput24h / 10);

  return (
    <div className="h-full overflow-y-auto bg-[#0a0a0b] text-white">
      {/* Header */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-[#0a0a0b]/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-4">
          <Link
            href="/missions"
            className="text-[11px] text-white/40 transition-colors hover:text-white/80"
          >
            ← Back to app
          </Link>
          <h1 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/70">
            Your Software Factory
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <LiveControl />
          <span className="rounded-md border border-white/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-white/40">
            14d
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-4 p-6">
        {/* Top band: SIGNAL sonar · pipeline stages · DEPLOY sonar */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-[150px_1fr_150px]">
          <div className="rounded-xl border border-white/10 bg-white/[0.015] p-4">
            <SonarGauge
              label="Signal"
              value={data.signal.value}
              caption={`${data.signal.throughput24h} events / 24h`}
              activity={signalActivity}
            />
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.015] p-0">
            <div className="border-b border-white/10 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-white/35">
              Pipeline
            </div>
            <StageStrip stages={data.stages} />
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.015] p-4">
            <SonarGauge
              label="Deploy"
              value={data.deploy.value}
              caption={`${data.deploy.throughput24h} merged / 24h`}
              activity={deployActivity}
              align="right"
            />
          </div>
        </section>

        {/* Headline metric cards */}
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {data.metrics.map((metric) => (
            <MetricCard key={metric.key} metric={metric} />
          ))}
        </section>

        <p className="pt-1 text-center text-[10px] uppercase tracking-wider text-white/25">
          Every figure derived from live Mission · Task · Ledger data
        </p>
      </main>
    </div>
  );
}
