import { FACTORY_ACCENT } from './theme';

/**
 * Animated radar/sonar gauge. Pure CSS animation (a rotating conic sweep plus
 * pinging blips) so it renders on the server and degrades to a static dial
 * under `prefers-reduced-motion`. The blip count scales with recent activity
 * so a busy factory visibly lights up.
 */
export function SonarGauge({
  label,
  value,
  caption,
  activity,
  align = 'left',
}: {
  label: string;
  value: number;
  caption: string;
  /** 0–1: how much recent throughput drives blip density. */
  activity: number;
  align?: 'left' | 'right';
}) {
  const blips = Math.max(1, Math.min(5, Math.round(activity * 5)));
  // Deterministic-ish blip positions (no client randomness → no hydration drift).
  const positions = [
    { x: 64, y: 38 },
    { x: 78, y: 70 },
    { x: 40, y: 82 },
    { x: 30, y: 52 },
    { x: 86, y: 48 },
  ].slice(0, blips);

  return (
    <div className="flex h-full flex-col justify-between">
      <div className="relative mx-auto aspect-square w-full max-w-[112px] overflow-hidden rounded-full border border-white/10">
        {/* Rings + crosshair */}
        <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full">
          {[18, 36, 54].map((r) => (
            <circle
              key={r}
              cx="60"
              cy="60"
              r={r}
              fill="none"
              stroke="currentColor"
              className="text-white/10"
              strokeWidth="1"
            />
          ))}
          <line
            x1="60"
            y1="6"
            x2="60"
            y2="114"
            stroke="currentColor"
            className="text-white/10"
            strokeWidth="1"
          />
          <line
            x1="6"
            y1="60"
            x2="114"
            y2="60"
            stroke="currentColor"
            className="text-white/10"
            strokeWidth="1"
          />
          {positions.map((p, i) => (
            <g key={i} style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
              <circle
                cx={p.x}
                cy={p.y}
                r="3"
                className="factory-ping"
                style={{
                  fill: FACTORY_ACCENT,
                  animationDelay: `${i * 0.5}s`,
                  transformOrigin: `${p.x}px ${p.y}px`,
                }}
              />
              <circle cx={p.x} cy={p.y} r="1.5" style={{ fill: FACTORY_ACCENT }} />
            </g>
          ))}
        </svg>
        {/* Rotating sweep */}
        <div
          className="factory-sweep absolute inset-0"
          style={{
            background: `conic-gradient(from 0deg, transparent 0deg, ${FACTORY_ACCENT}00 30deg, ${FACTORY_ACCENT}55 70deg, transparent 72deg)`,
          }}
        />
        <div className="absolute inset-0 rounded-full ring-1 ring-inset ring-white/5" />
      </div>

      <div className={align === 'right' ? 'text-right' : ''}>
        <p className="mt-3 text-[10px] uppercase tracking-[0.18em] text-white/40">{label}</p>
        <p className="font-mono text-3xl font-semibold leading-tight text-white tabular-nums">
          {value.toLocaleString()}
        </p>
        <p className="text-[10px] uppercase tracking-wider text-white/35">{caption}</p>
      </div>
    </div>
  );
}
