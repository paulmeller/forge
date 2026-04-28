import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { listSkills } from '@/lib/skills';
import { listTemplates } from '@/lib/templates';

import { NewMissionForm } from './new-mission-form';
import { TemplateCards } from './template-cards';

export const dynamic = 'force-dynamic';

export default async function NewMissionPage() {
  const [skills, templates] = await Promise.all([listSkills(), listTemplates()]);

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
      {templates.length > 0 && (
        <TemplateCards
          templates={templates.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            goalTemplate: t.goalTemplate,
            defaultBackend: t.defaultBackend,
            defaultConcurrencyCap: t.defaultConcurrencyCap,
            defaultBudgetUsd: t.defaultBudgetUsd,
            skillId: t.skillId,
          }))}
        />
      )}
      <NewMissionForm
        availableSkills={skills.map((s) => ({ id: s.id, name: s.name, slug: s.slug, description: s.description }))}
      />
    </main>
  );
}
