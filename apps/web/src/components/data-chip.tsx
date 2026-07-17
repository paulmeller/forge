import { cn } from '@/lib/utils';

/** Mono data chip for numbers and identifiers (spec §3). */
export function DataChip({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}
