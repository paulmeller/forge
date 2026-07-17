'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
    <div className="max-w-md space-y-4 rounded-lg border p-6">
      <div>
        <Label htmlFor="concurrencyCap">Concurrency cap</Label>
        <Input
          id="concurrencyCap"
          type="number"
          min={1}
          max={100}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Max issues this repo works at once, across all its issue missions.
        </p>
      </div>
      <div>
        <Label htmlFor="budgetUsd">Budget (USD, optional)</Label>
        <Input
          id="budgetUsd"
          type="number"
          min={1}
          placeholder="No cap"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-checkbox h-4 w-4"
          checked={aiReview}
          onChange={(e) => setAiReview(e.target.checked)}
        />
        AI review gate
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-checkbox h-4 w-4"
          checked={selfVerify}
          onChange={(e) => setSelfVerify(e.target.checked)}
        />
        Self-verify gate
      </label>
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={pending} variant="accent" size="sm">
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {message ? (
          <p className={`text-xs ${message.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
            {message.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
