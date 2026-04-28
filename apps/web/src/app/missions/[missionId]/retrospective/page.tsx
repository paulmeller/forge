import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MissionStatusBadge } from '@/components/mission-status-badge';
import { getMission } from '@/lib/missions';
import { getRetrospectiveForMission, listProposals } from '@/lib/retrospectives';

import { ProposalCard } from './proposal-card';
import { RequestRetroButton } from './request-retro-button';

export const dynamic = 'force-dynamic';

export default async function RetrospectivePage({
  params,
}: {
  params: Promise<{ missionId: string }>;
}) {
  const { missionId } = await params;
  const mission = await getMission(missionId);
  if (!mission) notFound();

  const retro = await getRetrospectiveForMission(missionId);
  const proposals = retro ? await listProposals(retro.id) : [];

  const pending = proposals.filter((p) => p.status === 'pending');
  const reviewed = proposals.filter((p) => p.status !== 'pending');

  return (
    <main className="container max-w-4xl py-8">
      <div className="mb-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
          <Link href={`/missions/${missionId}`}>&larr; {mission.name}</Link>
        </Button>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">Retrospective</h1>
              <MissionStatusBadge status={mission.status} />
            </div>
            {retro && (
              <p className="mt-1 text-sm text-muted-foreground">
                Status: <span className="font-mono">{retro.status}</span>
                {' \u00b7 '}
                {proposals.length} proposals ({pending.length} pending)
              </p>
            )}
          </div>
          {!retro && (mission.status === 'completed' || mission.status === 'cancelled') && (
            <RequestRetroButton missionId={missionId} />
          )}
        </div>
      </div>

      {!retro ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {mission.status === 'completed' || mission.status === 'cancelled'
              ? 'No retrospective yet. Click "Run Retrospective" to analyse this Mission.'
              : 'Retrospectives are available after a Mission completes or is cancelled.'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {retro.analysis && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Analysis</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{retro.analysis}</p>
              </CardContent>
            </Card>
          )}

          {pending.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Pending review ({pending.length})
              </h2>
              <div className="space-y-3">
                {pending.map((p) => (
                  <ProposalCard key={p.id} proposal={p} />
                ))}
              </div>
            </section>
          )}

          {reviewed.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Reviewed ({reviewed.length})
              </h2>
              <div className="space-y-3">
                {reviewed.map((p) => (
                  <ProposalCard key={p.id} proposal={p} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
