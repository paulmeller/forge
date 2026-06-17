import { FACTORY_ACCENT } from './theme';

/**
 * Filled area + line chart used by the headline factory cards. Pure SVG (no
 * charting dependency), normalised to the series max with a faint gridline
 * backdrop. A flat baseline renders when the series is empty or all-zero.
 */
export function AreaChart({
  values,
  height = 132,
  className,
  color = FACTORY_ACCENT,
}: {
  values: number[];
  height?: number;
  className?: string;
  color?: string;
}) {
  const width = 600; // viewBox units; scales to container via width=100%
  const pad = 6;
  const max = Math.max(1, ...values);
  const n = values.length;
  const id = `fac-grad-${color.replace('#', '')}`;

  const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * (width - pad * 2) + pad);
  const yOf = (v: number) => height - pad - (v / max) * (height - pad * 2);

  const pts = values.map((v, i) => [xOf(i), yOf(v)] as const);
  const last = pts[pts.length - 1];
  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  const area =
    pts.length > 0
      ? `${line} L ${xOf(n - 1).toFixed(1)} ${height - pad} L ${xOf(0).toFixed(1)} ${height - pad} Z`
      : '';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      width="100%"
      height={height}
      aria-hidden
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Gridlines */}
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={pad}
          x2={width - pad}
          y1={height - pad - f * (height - pad * 2)}
          y2={height - pad - f * (height - pad * 2)}
          stroke="currentColor"
          className="text-white/[0.06]"
          strokeWidth="1"
        />
      ))}

      {area && <path d={area} fill={`url(#${id})`} />}
      {pts.length > 0 && (
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="1.75"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* Leading-edge marker */}
      {last && <circle cx={last[0]} cy={last[1]} r="3" fill={color} className="factory-pulse" />}
    </svg>
  );
}
