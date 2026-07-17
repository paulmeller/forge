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
}: {
  prUrl: string;
  prNumber: number | null;
  status?: string;
}) {
  return (
    <a href={prUrl} target="_blank" rel="noreferrer">
      <Badge variant="outline">
        PR #{prNumber}
        {status ? ` · ${status}` : ''} ↗
      </Badge>
    </a>
  );
}
