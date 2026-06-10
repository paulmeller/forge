'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

import { createMissionAction, type CreateMissionState } from './actions';

const initialState: CreateMissionState = {};

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

type SkillOption = { id: string; name: string; slug: string; description: string | null };

export function NewMissionForm({ availableSkills = [] }: { availableSkills?: SkillOption[] }) {
  const [state, formAction, pending] = useActionState(createMissionAction, initialState);

  return (
    <form action={formAction} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
          <CardDescription>What is this Mission meant to do?</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              name="name"
              placeholder="Bump fast-glob across fleet"
              required
              maxLength={200}
            />
            <FieldError errors={state.fieldErrors} name="name" />
          </div>
          <div>
            <Label htmlFor="goal">Goal prompt</Label>
            <Textarea
              id="goal"
              name="goal"
              rows={5}
              placeholder="Update the `fast-glob` dependency to ^3.3.2 everywhere it appears in package.json. Run the tests. If the tests fail, revert."
              required
              maxLength={10_000}
            />
            <FieldError errors={state.fieldErrors} name="goal" />
          </div>
        </CardContent>
      </Card>

      {availableSkills.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Skill</CardTitle>
            <CardDescription>
              Optional. Attach a skill to scope the agent&apos;s toolset and provide a playbook.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Select name="skillId">
              <SelectTrigger id="skillId">
                <SelectValue placeholder="No skill (freestyle)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">No skill (freestyle)</SelectItem>
                {availableSkills.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                    {s.description ? ` \u2014 ${s.description.slice(0, 60)}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Execution</CardTitle>
          <CardDescription>Which engine will run the Tasks, and how aggressively?</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="backend">Backend</Label>
            <Select name="backend" defaultValue="managed-agents" required>
              <SelectTrigger id="backend">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="managed-agents">Anthropic Managed Agents</SelectItem>
                <SelectItem value="gateway">AgentStep Gateway</SelectItem>
              </SelectContent>
            </Select>
            <FieldError errors={state.fieldErrors} name="backend" />
          </div>
          <div>
            <Label htmlFor="agentId">Agent ID</Label>
            <Input
              id="agentId"
              name="agentId"
              placeholder="agent_abc123..."
              required
              maxLength={200}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Create the agent out-of-band (Anthropic CLI or console) and paste its ID here.
            </p>
            <FieldError errors={state.fieldErrors} name="agentId" />
          </div>
          <div>
            <Label htmlFor="plannerStrategy">Planner strategy</Label>
            <Select name="plannerStrategy" defaultValue="rule-based">
              <SelectTrigger id="plannerStrategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rule-based">Rule-based (one Task per repo)</SelectItem>
                <SelectItem value="llm">LLM (AI decomposes goal into dependent tasks)</SelectItem>
                <SelectItem value="graph" disabled>
                  Graph / DAG (coming soon)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="targetRepos">Target repositories</Label>
            <Textarea
              id="targetRepos"
              name="targetRepos"
              rows={6}
              placeholder="acme/api&#10;acme/web&#10;acme/mobile"
              className="font-mono text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              One <span className="font-mono">owner/repo</span> per line. Commas or whitespace also
              work. The Planner emits one Task per repo.
            </p>
            <FieldError errors={state.fieldErrors} name="targetRepos" />
          </div>
          <div>
            <Label htmlFor="concurrencyCap">Concurrency cap</Label>
            <Input
              id="concurrencyCap"
              name="concurrencyCap"
              type="number"
              min={1}
              max={100}
              defaultValue={5}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Max Tasks in flight at once for this Mission.
            </p>
            <FieldError errors={state.fieldErrors} name="concurrencyCap" />
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="aiReviewEnabled"
              name="aiReviewEnabled"
              className="h-4 w-4 rounded border-input"
            />
            <div>
              <Label htmlFor="aiReviewEnabled">AI code review before merge</Label>
              <p className="text-xs text-muted-foreground">
                AI reviews each PR against the mission goal before auto-merge.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="selfVerifyEnabled"
              name="selfVerifyEnabled"
              className="h-4 w-4 rounded border-input"
            />
            <div>
              <Label htmlFor="selfVerifyEnabled">Self-verification gate</Label>
              <p className="text-xs text-muted-foreground">
                A checker model confirms each PR meets its skill&apos;s acceptance criteria before
                review (a /goal-style done-check). Requires a skill with criteria.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Budget</CardTitle>
          <CardDescription>
            Mission auto-pauses when spend crosses the threshold. Leave blank for no cap.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="budgetUsd">Budget (USD)</Label>
              <Input id="budgetUsd" name="budgetUsd" type="number" min={1} placeholder="200" />
            </div>
            <div>
              <Label htmlFor="budgetTokens">Budget (tokens)</Label>
              <Input
                id="budgetTokens"
                name="budgetTokens"
                type="number"
                min={1}
                placeholder="1000000"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="budgetThresholdPct">Soft-pause threshold (%)</Label>
              <Input
                id="budgetThresholdPct"
                name="budgetThresholdPct"
                type="number"
                min={1}
                max={100}
                defaultValue={80}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Mission pauses; in-flight Tasks finish.
              </p>
            </div>
            <div>
              <Label htmlFor="budgetHardStopPct">Hard-stop ceiling (%)</Label>
              <Input
                id="budgetHardStopPct"
                name="budgetHardStopPct"
                type="number"
                min={1}
                max={500}
                defaultValue={100}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Cancels the Mission and kills in-flight sessions.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Per-task hard stops</CardTitle>
          <CardDescription>
            Optional overrides. Leave blank to use the skill&apos;s loop policy, then the env
            default. These halt a single runaway Task without pausing the whole Mission.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <Label htmlFor="taskMaxTurns">Max turns</Label>
            <Input id="taskMaxTurns" name="taskMaxTurns" type="number" min={1} placeholder="30" />
          </div>
          <div>
            <Label htmlFor="taskMaxTokens">Max tokens</Label>
            <Input
              id="taskMaxTokens"
              name="taskMaxTokens"
              type="number"
              min={1}
              placeholder="unbounded"
            />
          </div>
          <div>
            <Label htmlFor="noProgressTokens">No-progress tokens</Label>
            <Input
              id="noProgressTokens"
              name="noProgressTokens"
              type="number"
              min={1}
              placeholder="200000"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
          <CardDescription>Optional for now — required before dispatching Tasks.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="githubInstallationId">GitHub App installation ID (repo clone)</Label>
            <Input id="githubInstallationId" name="githubInstallationId" placeholder="12345678" />
          </div>
          <div>
            <Label htmlFor="githubVaultId">GitHub MCP vault ID (PR creation)</Label>
            <Input id="githubVaultId" name="githubVaultId" placeholder="vlt_..." />
          </div>
        </CardContent>
      </Card>

      {state.error ? (
        <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {state.error}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create Mission'}
        </Button>
      </div>
    </form>
  );
}
