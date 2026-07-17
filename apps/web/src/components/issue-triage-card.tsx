import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { TaskStatusBadge } from '@/components/task-status-badge';
import type { IssueGroup, TriageHeadline } from '@/lib/triage-view';
import { cn } from '@/lib/utils';

const HEADLINE: Record<TriageHeadline, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  reproducing: { label: 'Reproducing', variant: 'secondary' },
  not_reproduced: { label: 'Not reproduced', variant: 'outline' },
  fix_skipped: { label: 'Fix skipped', variant: 'outline' },
  fixing: { label: 'Fixing', variant: 'default' },
  fixed: { label: 'Fixed', variant: 'default' },
  fix_review: { label: 'Awaiting review', variant: 'secondary' },
  failed: { label: 'Failed', variant: 'destructive' },
};

function StageRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-20 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function IssueTriageCard({ group, missionId }: { group: IssueGroup; missionId: string }) {
  const headline = HEADLINE[group.headline];
  const latest = group.attempts.at(-1) ?? null;
  const verdict = latest?.reproduce?.verdict ?? null;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {group.issueNumber != null && (
              <span className="font-mono text-sm text-muted-foreground">#{group.issueNumber}</span>
            )}
            {group.url ? (
              <a
                href={group.url}
                target="_blank"
                rel="noreferrer"
                className="truncate text-sm font-medium hover:underline"
              >
                {group.title}
              </a>
            ) : (
              <span className="truncate text-sm font-medium">{group.title}</span>
            )}
          </div>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{group.repo}</p>
        </div>
        <Badge variant={headline.variant}>{headline.label}</Badge>
      </div>

      <div className="divide-y">
        <StageRow label="Reproduce">
          {latest?.reproduce ? (
            <>
              <TaskStatusBadge status={latest.reproduce.status} haltReason={latest.reproduce.haltReason} />
              {verdict && (
                <Badge variant={verdict.reproduced ? 'default' : 'outline'}>
                  {verdict.reproduced ? 'reproduced' : 'could not reproduce'}
                </Badge>
              )}
              {verdict?.affectedVersions &&
                Object.entries(verdict.affectedVersions).map(([v, hit]) => (
                  <span
                    key={v}
                    className={cn(
                      'rounded px-1.5 py-0.5 font-mono text-[11px]',
                      hit ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {v} {hit ? '✗' : '✓'}
                  </span>
                ))}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </StageRow>

        {verdict?.summary && (
          <p className="py-1.5 pl-[92px] text-xs text-muted-foreground">{verdict.summary}</p>
        )}

        <StageRow label="Fix">
          {latest?.fix ? (
            <>
              <TaskStatusBadge status={latest.fix.status} haltReason={latest.fix.haltReason} />
              {latest.fix.prUrl && (
                <a
                  href={latest.fix.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  PR #{latest.fix.prNumber ?? ''}
                </a>
              )}
              {group.headline === 'fix_skipped' && (
                <span className="text-xs text-muted-foreground">gated — bug did not reproduce</span>
              )}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </StageRow>
      </div>

      <div className="mt-2 flex gap-3">
        {latest?.reproduce && (
          <Link
            href={`/missions/${missionId}/tasks/${latest.reproduce.id}`}
            className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          >
            reproduce task →
          </Link>
        )}
        {latest?.fix && (
          <Link
            href={`/missions/${missionId}/tasks/${latest.fix.id}`}
            className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          >
            fix task →
          </Link>
        )}
      </div>
    </div>
  );
}
