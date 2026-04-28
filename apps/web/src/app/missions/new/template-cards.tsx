'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type TemplateOption = {
  id: string;
  name: string;
  description: string;
  goalTemplate: string;
  defaultBackend: string;
  defaultConcurrencyCap: number;
  defaultBudgetUsd: number | null;
  skillId: string | null;
};

export function TemplateCards({ templates }: { templates: TemplateOption[] }) {
  function applyTemplate(template: TemplateOption) {
    const nameInput = document.querySelector<HTMLInputElement>('input[name="name"]');
    const goalInput = document.querySelector<HTMLTextAreaElement>('textarea[name="goal"]');
    const concurrencyInput = document.querySelector<HTMLInputElement>('input[name="concurrencyCap"]');
    const budgetInput = document.querySelector<HTMLInputElement>('input[name="budgetUsd"]');

    if (nameInput) {
      nameInput.value = template.name;
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (goalInput) {
      goalInput.value = template.goalTemplate;
      goalInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (concurrencyInput) {
      concurrencyInput.value = String(template.defaultConcurrencyCap);
      concurrencyInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (budgetInput && template.defaultBudgetUsd) {
      budgetInput.value = String(template.defaultBudgetUsd);
      budgetInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  return (
    <div className="mb-6">
      <h2 className="mb-3 text-lg font-medium">Templates</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {templates.map((t) => (
          <button key={t.id} type="button" onClick={() => applyTemplate(t)} className="text-left">
            <Card className="h-full cursor-pointer transition-colors hover:border-primary">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{t.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription className="text-xs">{t.description}</CardDescription>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>
    </div>
  );
}
