'use client';

import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MissionDefaults } from '@/lib/mission-defaults';

export type SkillOption = { id: string; name: string; slug: string; description: string | null };

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
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

/**
 * Collapsed-by-default power settings. Stays mounted (`hidden` attr) so every
 * named field submits even while collapsed — collapsing hides, never unsets.
 */
export function AdvancedSettings({
  open,
  skills,
  defaults,
  missionType,
  decompStrategy,
  onDecompChange,
  fieldErrors,
}: {
  open: boolean;
  skills: SkillOption[];
  defaults: MissionDefaults;
  missionType: 'fleet' | 'single' | 'triage';
  decompStrategy: string;
  onDecompChange: (v: string) => void;
  fieldErrors: Record<string, string> | undefined;
}) {
  return (
    <Card
      id="advanced-panel"
      hidden={!open}
      className="flex flex-col gap-6 p-6"
    >
      <div className="flex flex-col gap-4">
        <GroupLabel>Mission</GroupLabel>
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" placeholder="Auto-generated from goal" maxLength={200} />
          <FieldError errors={fieldErrors} name="name" />
        </div>
        {skills.length > 0 ? (
          <div>
            <Label htmlFor="skillId">Skill</Label>
            <Select name="skillId">
              <SelectTrigger id="skillId">
                <SelectValue placeholder="No skill (freestyle)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No skill (freestyle)</SelectItem>
                {skills.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                    {s.description ? ` — ${s.description.slice(0, 60)}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-4">
        <GroupLabel>Execution</GroupLabel>
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
          <FieldError errors={fieldErrors} name="backend" />
        </div>
        <div>
          <Label htmlFor="agentId">Agent ID</Label>
          <Input
            id="agentId"
            name="agentId"
            placeholder="agent_abc123..."
            maxLength={200}
            defaultValue={defaults.agentId ?? ''}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {defaults.source === 'setup'
              ? 'Resolved from your Setup installation.'
              : defaults.source === 'env'
                ? 'Resolved from the env default.'
                : 'Create the agent out-of-band (Anthropic CLI or console) and paste its ID here.'}
          </p>
          <FieldError errors={fieldErrors} name="agentId" />
        </div>
        {missionType !== 'triage' ? (
          <div>
            <Label htmlFor="decompStrategy">Decomposition strategy</Label>
            <Select value={decompStrategy} onValueChange={onDecompChange}>
              <SelectTrigger id="decompStrategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rule-based">
                  {missionType === 'fleet'
                    ? 'Rule-based — one Task per repo'
                    : 'Rule-based — single Task'}
                </SelectItem>
                <SelectItem value="llm">LLM — decomposes goal into dependent tasks</SelectItem>
                <SelectItem value="graph" disabled>
                  Graph / DAG — coming soon
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}
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
          <FieldError errors={fieldErrors} name="concurrencyCap" />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <GroupLabel>Gates</GroupLabel>
        <div className="flex items-center gap-3">
          <Checkbox id="aiReviewEnabled" name="aiReviewEnabled" />
          <div>
            <Label htmlFor="aiReviewEnabled">AI code review before merge</Label>
            <p className="text-xs text-muted-foreground">
              AI reviews each PR against the mission goal before auto-merge.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Checkbox id="selfVerifyEnabled" name="selfVerifyEnabled" />
          <div>
            <Label htmlFor="selfVerifyEnabled">Self-verification gate</Label>
            <p className="text-xs text-muted-foreground">
              A checker model confirms each PR meets its skill&apos;s acceptance criteria before
              review (a /goal-style done-check). Requires a skill with criteria.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <GroupLabel>Budget</GroupLabel>
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
      </div>

      <div className="flex flex-col gap-4">
        <GroupLabel>Per-task hard stops</GroupLabel>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
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
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <GroupLabel>GitHub</GroupLabel>
        <div>
          <Label htmlFor="githubInstallationId">GitHub App installation ID (repo clone)</Label>
          <Input
            id="githubInstallationId"
            name="githubInstallationId"
            placeholder="12345678"
            defaultValue={defaults.githubInstallationId ?? ''}
          />
        </div>
        <div>
          <Label htmlFor="githubVaultId">GitHub MCP vault ID (PR creation)</Label>
          <Input
            id="githubVaultId"
            name="githubVaultId"
            placeholder="vlt_..."
            defaultValue={defaults.githubVaultId ?? ''}
          />
        </div>
      </div>
    </Card>
  );
}
