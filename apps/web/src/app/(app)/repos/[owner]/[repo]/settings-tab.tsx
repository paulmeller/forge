'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent } from '@/components/ui/card';

import { updateRepoSettings } from './settings-actions';

export function SettingsTab({
  containerId,
  concurrencyCap,
  budgetUsd,
  aiReviewEnabled,
  selfVerifyEnabled,
}: {
  containerId: string;
  concurrencyCap: number;
  budgetUsd: number | null;
  aiReviewEnabled: boolean;
  selfVerifyEnabled: boolean;
}) {
  const [cap, setCap] = useState(String(concurrencyCap));
  const [budget, setBudget] = useState(budgetUsd !== null ? String(budgetUsd) : '');
  const [aiReview, setAiReview] = useState(aiReviewEnabled);
  const [selfVerify, setSelfVerify] = useState(selfVerifyEnabled);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  function handleSave() {
    setMessage(null);
    const parsedCap = Number(cap);
    const parsedBudget = budget.trim() === '' ? null : Number(budget);
    startTransition(async () => {
      const result = await updateRepoSettings(containerId, {
        concurrencyCap: parsedCap,
        budgetUsd: parsedBudget,
        aiReviewEnabled: aiReview,
        selfVerifyEnabled: selfVerify,
      });
      setMessage(
        result.ok ? { kind: 'ok', text: 'Saved.' } : { kind: 'error', text: result.error },
      );
    });
  }

  return (
    <Card className="max-w-md">
      <CardContent className="p-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="concurrencyCap">Concurrency cap</FieldLabel>
          <Input
            id="concurrencyCap"
            type="number"
            min={1}
            max={100}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
          <FieldDescription>
            Max issues this repo works at once, across all its issue missions.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="budgetUsd">Budget (USD, optional)</FieldLabel>
          <Input
            id="budgetUsd"
            type="number"
            min={1}
            placeholder="No cap"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id="aiReviewEnabled"
            checked={aiReview}
            onCheckedChange={(checked) => setAiReview(checked === true)}
          />
          <FieldLabel htmlFor="aiReviewEnabled" className="font-normal">
            AI review gate
          </FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id="selfVerifyEnabled"
            checked={selfVerify}
            onCheckedChange={(checked) => setSelfVerify(checked === true)}
          />
          <FieldLabel htmlFor="selfVerifyEnabled" className="font-normal">
            Self-verify gate
          </FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <Button onClick={handleSave} disabled={pending} size="sm">
            {pending ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
          {message ? (
            <FieldDescription className={message.kind === 'error' ? 'text-destructive' : undefined}>
              {message.text}
            </FieldDescription>
          ) : null}
        </Field>
      </FieldGroup>
      </CardContent>
    </Card>
  );
}
