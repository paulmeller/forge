import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { PageHeader, PageShell } from '@/components/page-shell';
import { resolveMissionDefaults, listUserRepos } from '@/lib/mission-defaults-db';
import { listSkills } from '@/lib/skills';
import { withAuth } from '@/lib/with-auth';

import { NewMissionForm } from './new-mission-form';

export const dynamic = 'force-dynamic';

export default async function NewMissionPage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string }>;
}) {
  const { repo } = await searchParams;
  const user = await withAuth();
  const [skills, defaults, availableRepos] = await Promise.all([
    listSkills(),
    resolveMissionDefaults(user.id),
    listUserRepos(user.id),
  ]);

  return (
    <PageShell className="max-w-3xl py-10">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4">
        <Link href="/missions">&larr; Back to missions</Link>
      </Button>
      <PageHeader
        title="New Mission"
        subtitle="Describe the work. Forge plans it into Tasks you review before anything dispatches."
      />
      <NewMissionForm
        availableSkills={skills.map((s) => ({
          id: s.id,
          name: s.name,
          slug: s.slug,
          description: s.description,
        }))}
        availableRepos={availableRepos}
        defaults={defaults}
        initialRepo={repo}
      />
    </PageShell>
  );
}
