import { Badge } from '@/components/ui/badge';

/**
 * Shared PR chip, replacing the hand-rolled blue-bordered anchors
 * previously duplicated in queue-section.tsx and issue-run-panel.tsx.
 *
 * The installed `ui/badge.tsx` doesn't support `asChild` (no Slot usage),
 * so the anchor wraps the Badge rather than the other way around.
 */
export function PrChip({
  prUrl,
  prNumber,
  status,
  linked = true,
}: {
  prUrl: string;
  prNumber: number | null;
  status?: string;
  linked?: boolean;
}) {
  const label = (
    <>
      PR #{prNumber}
      {status ? ` · ${status}` : ''}
    </>
  );
  if (!linked) {
    return <Badge variant="outline">{label}</Badge>;
  }
  return (
    <a href={prUrl} target="_blank" rel="noreferrer" className="inline-flex">
      <Badge variant="outline">{label} ↗</Badge>
    </a>
  );
}
