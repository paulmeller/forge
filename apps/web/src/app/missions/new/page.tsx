import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { listSkills } from '@/lib/skills';

import { NewMissionForm } from './new-mission-form';

export const dynamic = 'force-dynamic';

export default async function NewMissionPage() {
  const skills = await listSkills();

  return (
    <main className="container max-w-3xl py-10">
      <div className="mb-8">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4">
          <Link href="/missions">&larr; Back to missions</Link>
        </Button>
        <h1 className="text-3xl font-semibold tracking-tight">New Mission</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Missions start in <span className="font-mono">draft</span>. You can edit and plan before
          dispatching any Tasks.
        </p>
      </div>
      <NewMissionForm
        availableSkills={skills.map((s) => ({ id: s.id, name: s.name, slug: s.slug, description: s.description }))}
      />
    </main>
  );
}
