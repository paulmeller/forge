'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

import { parseLines } from '@/lib/parse-lines';
import { parseOptionalNumber } from '@/lib/parse-optional-number';

import type { AutoMergePolicy } from '@forge/db';

import { updateRepoSettings } from './settings-actions';

export function SettingsTab({
  containerId,
  concurrencyCap,
  budgetUsd,
  aiReviewEnabled,
  selfVerifyEnabled,
  autoMergePolicy,
  requirePlanApproval,
}: {
  containerId: string;
  concurrencyCap: number;
  budgetUsd: number | null;
  aiReviewEnabled: boolean;
  selfVerifyEnabled: boolean;
  autoMergePolicy: AutoMergePolicy | null;
  requirePlanApproval: boolean;
}) {
  const [cap, setCap] = useState(String(concurrencyCap));
  const [budget, setBudget] = useState(budgetUsd !== null ? String(budgetUsd) : '');
  const [aiReview, setAiReview] = useState(aiReviewEnabled);
  const [selfVerify, setSelfVerify] = useState(selfVerifyEnabled);
  const [amEnabled, setAmEnabled] = useState(autoMergePolicy?.enabled ?? false);
  const [maxAdd, setMaxAdd] = useState(autoMergePolicy?.maxAdditions?.toString() ?? '');
  const [maxDel, setMaxDel] = useState(autoMergePolicy?.maxDeletions?.toString() ?? '');
  const [maxFiles, setMaxFiles] = useState(autoMergePolicy?.maxFilesChanged?.toString() ?? '');
  const [checks, setChecks] = useState((autoMergePolicy?.requiredChecks ?? []).join('\n'));
  const [paths, setPaths] = useState((autoMergePolicy?.allowedPathPatterns ?? []).join('\n'));
  const [requireApproval, setRequireApproval] = useState(
    autoMergePolicy?.requireHumanApproval ?? false,
  );
  const [planApproval, setPlanApproval] = useState(requirePlanApproval);
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
        autoMerge: {
          enabled: amEnabled,
          maxAdditions: parseOptionalNumber(maxAdd),
          maxDeletions: parseOptionalNumber(maxDel),
          maxFilesChanged: parseOptionalNumber(maxFiles),
          requiredChecks: parseLines(checks),
          allowedPathPatterns: parseLines(paths),
          requireHumanApproval: requireApproval,
        },
        requirePlanApproval: planApproval,
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
            <Checkbox
              id="amEnabled"
              checked={amEnabled}
              onCheckedChange={(checked) => setAmEnabled(checked === true)}
            />
            <FieldLabel htmlFor="amEnabled" className="font-normal">
              Auto-merge
            </FieldLabel>
          </Field>
          <Field>
            <FieldLabel htmlFor="maxAdd">Max additions</FieldLabel>
            <Input
              id="maxAdd"
              type="number"
              min={0}
              placeholder="No cap"
              value={maxAdd}
              onChange={(e) => setMaxAdd(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="maxDel">Max deletions</FieldLabel>
            <Input
              id="maxDel"
              type="number"
              min={0}
              placeholder="No cap"
              value={maxDel}
              onChange={(e) => setMaxDel(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="maxFiles">Max files changed</FieldLabel>
            <Input
              id="maxFiles"
              type="number"
              min={0}
              placeholder="No cap"
              value={maxFiles}
              onChange={(e) => setMaxFiles(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="checks">Required checks</FieldLabel>
            <Textarea
              id="checks"
              rows={3}
              placeholder="One check name per line"
              value={checks}
              onChange={(e) => setChecks(e.target.value)}
            />
            <FieldDescription>
              Blocks the merge unless the branch actually requires each of these. Leave blank to
              rely on branch protection alone.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="paths">Allowed paths</FieldLabel>
            <Textarea
              id="paths"
              rows={3}
              placeholder="One glob per line, e.g. docs/**"
              value={paths}
              onChange={(e) => setPaths(e.target.value)}
            />
            <FieldDescription>Blank means any path may change.</FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id="requireApproval"
              checked={requireApproval}
              onCheckedChange={(checked) => setRequireApproval(checked === true)}
            />
            <FieldLabel htmlFor="requireApproval" className="font-normal">
              Require human approval
            </FieldLabel>
          </Field>
          <FieldDescription>
            Only tasks someone approved will auto-merge. This records that a human looked — it
            does not require a second person, so you can approve your own work.
          </FieldDescription>
          <Field orientation="horizontal">
            <Checkbox
              id="planApproval"
              checked={planApproval}
              onCheckedChange={(checked) => setPlanApproval(checked === true)}
            />
            <FieldLabel htmlFor="planApproval" className="font-normal">
              Require plan approval for @forge
            </FieldLabel>
          </Field>
          <FieldDescription>
            When on, an @forge comment produces a plan you approve before any agent starts.
          </FieldDescription>
          <Field orientation="horizontal">
            <Button onClick={handleSave} disabled={pending} size="sm">
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
            {message ? (
              <FieldDescription
                className={message.kind === 'error' ? 'text-destructive' : undefined}
              >
                {message.text}
              </FieldDescription>
            ) : null}
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
