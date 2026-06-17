import type { FactoryStage } from '@/lib/factory';

import { FACTORY_ACCENT } from './theme';

/**
 * The pipeline header: one column per stage with a live backlog count, 24h
 * throughput, and a tiny capacity bar. Stages map 1:1 onto Forge's real Task
 * lifecycle — nothing here is decorative.
 */
export function StageStrip({ stages }: { stages: FactoryStage[] }) {
  const maxBacklog = Math.max(1, ...stages.map((s) => s.backlog));

  return (
    <div className="grid grid-cols-2 divide-y divide-white/10 border border-white/10 sm:grid-cols-4 sm:divide-y-0 lg:grid-cols-7 lg:divide-x">
      {stages.map((stage, i) => (
        <div
          key={stage.key}
          className={`relative px-4 py-3 ${i % 2 === 1 ? 'border-l border-white/10 sm:border-l-0 lg:border-l' : ''}`}
        >
          <div className="flex items-center gap-1.5">
            <span
              className={stage.throughput > 0 ? 'factory-pulse' : ''}
              style={{
                display: 'inline-block',
                width: 5,
                height: 5,
                borderRadius: 9999,
                background: stage.throughput > 0 ? FACTORY_ACCENT : '#3f3f46',
              }}
            />
            <p className="text-[9px] font-medium uppercase tracking-[0.16em] text-white/45">
              {stage.label}
            </p>
          </div>

          <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-white">
            {stage.backlog}
          </p>

          <div className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.round((stage.backlog / maxBacklog) * 100)}%`,
                background: FACTORY_ACCENT,
                opacity: 0.7,
              }}
            />
          </div>

          <p className="mt-2 text-[9px] uppercase tracking-wider text-white/30">
            {stage.throughput} / 24h
          </p>
        </div>
      ))}
    </div>
  );
}
