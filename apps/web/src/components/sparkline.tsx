import { cn } from '@/lib/utils';

/**
 * Tiny SVG sparkline. Pure path, no fill, no axes — built for table-cell
 * density. Heights normalised to the max value so even noisy series stay
 * legible. If `values` is all zeros, renders a flat baseline.
 */
export function Sparkline({
  values,
  width = 80,
  height = 18,
  className,
  strokeWidth = 1.25,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  strokeWidth?: number;
}) {
  if (values.length === 0) {
    return (
      <svg width={width} height={height} aria-hidden className={cn('opacity-40', className)}>
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="currentColor" strokeWidth={1} />
      </svg>
    );
  }

  const max = Math.max(1, ...values);
  const stepX = values.length === 1 ? 0 : width / (values.length - 1);
  const yOf = (v: number) => height - 1 - (v / max) * (height - 2);

  const d = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * stepX).toFixed(1)} ${yOf(v).toFixed(1)}`)
    .join(' ');

  return (
    <svg width={width} height={height} aria-hidden className={className}>
      <path d={d} stroke="currentColor" fill="none" strokeWidth={strokeWidth} />
    </svg>
  );
}
