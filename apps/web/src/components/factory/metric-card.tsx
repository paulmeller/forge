import type { FactoryMetric } from '@/lib/factory';

import { AreaChart } from './area-chart';
import { FACTORY_ACCENT } from './theme';

/** A headline factory metric: big number, signed delta, and an area chart. */
export function MetricCard({ metric }: { metric: FactoryMetric }) {
  const up = metric.deltaPct >= 0;
  return (
    <div className="flex flex-col rounded-xl border border-white/10 bg-white/[0.015] p-5">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">{metric.label}</p>
        <p className="text-[10px] uppercase tracking-wider text-white/30">{metric.unit}</p>
      </div>

      <div className="flex items-baseline gap-3">
        <span className="font-mono text-4xl font-semibold tabular-nums text-white">
          {metric.value.toLocaleString()}
        </span>
        <span
          className="font-mono text-xs tabular-nums"
          style={{ color: up ? FACTORY_ACCENT : '#d65a4a' }}
        >
          {up ? '▲' : '▼'} {Math.abs(metric.deltaPct)}%
        </span>
        <span className="text-[10px] uppercase tracking-wider text-white/30">this week</span>
      </div>

      <div className="mt-4 flex-1">
        <AreaChart values={metric.series} />
      </div>

      <p className="mt-2 text-[10px] uppercase tracking-wider text-white/30">{metric.caption}</p>
    </div>
  );
}
