'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { RetrospectiveProposal } from '@forge/db';
import { cn } from '@/lib/utils';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-warning/15 text-warning',
  accepted: 'bg-live/15 text-live',
  rejected: 'bg-destructive/15 text-destructive',
  edited: 'bg-secondary text-secondary-foreground',
};

export function ProposalCard({ proposal }: { proposal: RetrospectiveProposal }) {
  const router = useRouter();
  const [acting, setActing] = useState(false);
  const content = proposal.content as Record<string, unknown> | null;
  const evidence = (proposal.evidenceEventIds ?? []) as string[];

  async function review(decision: 'accepted' | 'rejected') {
    setActing(true);
    await fetch(`/api/proposals/${proposal.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    setActing(false);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">
            <span className="font-mono">{proposal.type}</span>
          </CardTitle>
          <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', STATUS_COLORS[proposal.status])}>
            {proposal.status}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {content && (
          <div className="flex flex-col gap-1 text-xs">
            {proposal.type === 'skill_diff' && (
              <>
                <p><span className="text-muted-foreground">Skill:</span> {String(content.skillSlug ?? '')}</p>
                <p className="text-muted-foreground">{String(content.rationale ?? '')}</p>
                {content.diff && (
                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px] leading-tight">
                    {String(content.diff)}
                  </pre>
                )}
              </>
            )}
            {proposal.type === 'memory_entry' && (
              <>
                <p>
                  <span className="text-muted-foreground">Scope:</span>{' '}
                  <span className="font-mono">{String(content.scope ?? '')}/{String(content.scopeKey ?? '')}</span>
                </p>
                <p>
                  <span className="text-muted-foreground">Key:</span>{' '}
                  <span className="font-mono">{String(content.key ?? '')}</span>
                </p>
                <p>{String(content.value ?? '')}</p>
                <p className="text-muted-foreground">
                  Confidence: {String(content.confidence ?? '?')} &mdash; {String(content.rationale ?? '')}
                </p>
              </>
            )}
          </div>
        )}

        {evidence.length > 0 && (
          <p className="text-[10px] text-muted-foreground">
            Evidence: {evidence.map((id) => id.slice(0, 12)).join(', ')}
          </p>
        )}

        {proposal.status === 'pending' && (
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={() => review('accepted')} disabled={acting}>
              Accept
            </Button>
            <Button size="sm" variant="outline" onClick={() => review('rejected')} disabled={acting}>
              Reject
            </Button>
          </div>
        )}

        {proposal.reviewedBy && (
          <p className="text-[10px] text-muted-foreground">
            Reviewed by {proposal.reviewedBy}
            {proposal.reviewedAt ? ` at ${new Date(proposal.reviewedAt).toLocaleString()}` : ''}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
