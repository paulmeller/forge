'use client';

import { useActionState, useState } from 'react';
import { Bug, Check, GitBranch, LayoutGrid } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { MissionDefaults } from '@/lib/mission-defaults';
import { cn } from '@/lib/utils';

import { AdvancedSettings, type SkillOption } from './advanced-settings';
import { createMissionAction, type CreateMissionState } from './actions';
import { RepoPicker } from './repo-picker';

const initialState: CreateMissionState = {};

const MISSION_TYPES = [
  {
    value: 'fleet',
    label: 'Fleet',
    description: 'Goal → Tasks across a list of repos. Each Task opens a PR, gated on CI.',
    icon: LayoutGrid,
  },
  {
    value: 'single',
    label: 'Single repo',
    description: 'Goal → Tasks against one repo. Opens a PR, gated on CI.',
    icon: GitBranch,
  },
  {
    value: 'triage',
    label: 'Bug triage',
    description:
      'Issue query → a reproduce → fix pair per matching issue. Fixes dispatch only once a bug is confirmed.',
    icon: Bug,
  },
] as const;

export function NewMissionForm({
  availableSkills = [],
  availableRepos = [],
  defaults,
}: {
  availableSkills?: SkillOption[];
  availableRepos?: string[];
  defaults: MissionDefaults;
}) {
  const [state, formAction, pending] = useActionState(createMissionAction, initialState);
  const [missionType, setMissionType] = useState<'fleet' | 'single' | 'triage'>('single');
  const [decompStrategy, setDecompStrategy] = useState('rule-based');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isTriage = missionType === 'triage';
  const plannerStrategy = isTriage ? 'triage' : decompStrategy;

  const needsSetup = !defaults.agentId || !defaults.githubInstallationId;
  const agentNote =
    defaults.source === 'setup'
      ? 'agent from Setup'
      : defaults.source === 'env'
        ? 'agent from env default'
        : 'no agent — connect in Setup';

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="plannerStrategy" value={plannerStrategy} />

      <div>
        <Label htmlFor="goal">Goal</Label>
        <Textarea
          id="goal"
          name="goal"
          rows={5}
          className="mt-1 text-base"
          placeholder="Update the `fast-glob` dependency to ^3.3.2 everywhere it appears in package.json. Run the tests. If the tests fail, revert."
          required
          maxLength={10_000}
        />
        <FieldError errors={state.fieldErrors} name="goal" />
        <FieldError errors={state.fieldErrors} name="name" />
      </div>

      <div>
        <Label id="mission-type-label">Mission type</Label>
        <div
          role="radiogroup"
          aria-labelledby="mission-type-label"
          className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3"
        >
          {MISSION_TYPES.map((option) => {
            const Icon = option.icon;
            const selected = missionType === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setMissionType(option.value)}
                className={cn(
                  'relative rounded-lg border p-3 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  selected
                    ? 'border-transparent ring-2 ring-[color:var(--forge-accent-to)]'
                    : 'border-input hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {selected ? (
                  <span className="absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full bg-[color:var(--forge-accent-to)]">
                    <Check className="h-2.5 w-2.5 text-[color:var(--forge-accent-ink)]" />
                  </span>
                ) : null}
                <Icon className="h-4 w-4 text-muted-foreground" />
                <p className="mt-2 text-sm font-medium">{option.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{option.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      {isTriage ? (
        <div>
          <Label htmlFor="issueQuery">Issue search query</Label>
          <Input
            id="issueQuery"
            name="issueQuery"
            placeholder="repo:vercel/ai is:issue is:open label:bug"
            maxLength={500}
            className="font-mono text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            A GitHub issue search. Each matching issue becomes a gated{' '}
            <span className="font-mono">reproduce → fix</span> Task pair.
          </p>
          <FieldError errors={state.fieldErrors} name="issueQuery" />
        </div>
      ) : (
        <RepoPicker
          mode={missionType === 'fleet' ? 'multi' : 'single'}
          availableRepos={availableRepos}
          error={state.fieldErrors?.targetRepos}
        />
      )}

      {needsSetup ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          Missions can be planned now, but connect GitHub in{' '}
          <Link href="/setup" className="underline underline-offset-2">
            Setup
          </Link>{' '}
          before dispatching.
        </div>
      ) : null}

      {state.error ? (
        <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {state.error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {agentNote} · plan reviewed before dispatch ·{' '}
          <button
            type="button"
            aria-expanded={showAdvanced}
            aria-controls="advanced-panel"
            onClick={() => setShowAdvanced((v) => !v)}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Advanced settings
          </button>
        </p>
        <Button type="submit" variant="accent" disabled={pending}>
          {pending ? 'Creating…' : 'Create Mission'}
        </Button>
      </div>

      <AdvancedSettings
        open={showAdvanced}
        skills={availableSkills}
        defaults={defaults}
        missionType={missionType}
        decompStrategy={decompStrategy}
        onDecompChange={setDecompStrategy}
        fieldErrors={state.fieldErrors}
      />
    </form>
  );
}

function FieldError({
  errors,
  name,
}: {
  errors: Record<string, string> | undefined;
  name: string;
}) {
  if (!errors?.[name]) return null;
  return <p className="mt-1 text-xs text-destructive">{errors[name]}</p>;
}
