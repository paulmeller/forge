import { notFound } from 'next/navigation';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { MissionStatusBadge } from '@/components/mission-status-badge';
import { PageHeader, PageShell } from '@/components/page-shell';
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
    <PageShell className="max-w-4xl">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Retrospective
            <span className="normal-case">
              <MissionStatusBadge status={mission.status} />
            </span>
          </span>
        }
        subtitle={
          retro ? (
            <>
              Status: <span className="font-mono">{retro.status}</span>
              {' \u00b7 '}
              {proposals.length} proposals ({pending.length} pending)
            </>
          ) : undefined
        }
        actions={
          !retro && (mission.status === 'completed' || mission.status === 'cancelled') ? (
            <RequestRetroButton missionId={missionId} />
          ) : undefined
        }
      />

      {!retro ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>
              {mission.status === 'completed' || mission.status === 'cancelled'
                ? 'No retrospective yet. Click "Run Retrospective" to analyse this Mission.'
                : 'Retrospectives are available after a Mission completes or is cancelled.'}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
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
              <div className="flex flex-col gap-3">
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
              <div className="flex flex-col gap-3">
                {reviewed.map((p) => (
                  <ProposalCard key={p.id} proposal={p} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </PageShell>
  );
}
