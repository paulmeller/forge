'use client';

import { useActionState, useCallback, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import type { Task } from '@forge/db';

import { groupTasksByIssue } from '@/lib/triage-view';

import { addTaskAction, removeTaskAction, updatePromptVarsAction } from './actions';

const initial = {};

const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return template.replace(TEMPLATE_VAR_RE, (_match, key: string) => {
    const val = vars[key];
    if (val === null || val === undefined) return '';
    return String(val);
  });
}

export function PlanEditor({
  missionId,
  initialTasks,
  goalTemplate,
}: {
  missionId: string;
  initialTasks: Task[];
  goalTemplate: string;
}) {
  const [addState, addAction, addPending] = useActionState(addTaskAction, initial);
  const [showAdd, setShowAdd] = useState(false);

  // Triage plans are auto-generated reproduce→fix pairs — show them grouped by
  // issue (read-only) rather than as a flat, individually-editable Task list.
  const isTriage = initialTasks.some((t) => t.kind === 'reproduce' || t.kind === 'fix');
  if (isTriage) {
    return <TriagePlanView tasks={initialTasks} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Tasks ({initialTasks.length})
        </h2>
        <Button size="sm" variant="outline" onClick={() => setShowAdd((s) => !s)}>
          {showAdd ? 'Cancel' : 'Add Task'}
        </Button>
      </div>

      {showAdd && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Add Task</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              action={addAction}
              className="flex flex-col gap-3"
              onSubmit={() => setTimeout(() => setShowAdd(false), 100)}
            >
              <input type="hidden" name="missionId" value={missionId} />
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <Label htmlFor="repo">Repo</Label>
                  <Input id="repo" name="repo" placeholder="acme/api" required pattern="[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+" />
                </div>
                <div>
                  <Label htmlFor="baseBranch">Base branch</Label>
                  <Input id="baseBranch" name="baseBranch" placeholder="main" defaultValue="main" />
                </div>
              </div>
              {(addState as { error?: string }).error ? (
                <p className="text-xs text-destructive">{(addState as { error?: string }).error}</p>
              ) : null}
              <Button type="submit" size="sm" disabled={addPending}>
                {addPending ? <Spinner data-icon="inline-start" /> : null}
                Add
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {initialTasks.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No Tasks. Add at least one before starting.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol className="flex flex-col gap-2">
          {initialTasks.map((task) => (
            <TaskRow key={task.id} task={task} missionId={missionId} goalTemplate={goalTemplate} />
          ))}
        </ol>
      )}
    </div>
  );
}

function TriagePlanView({ tasks }: { tasks: Task[] }) {
  const groups = groupTasksByIssue(tasks);
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {groups.length} issue{groups.length === 1 ? '' : 's'} → {tasks.length} Tasks
      </h2>
      <p className="text-xs text-muted-foreground">
        Each issue is planned as a gated <span className="font-mono">reproduce → fix</span> pair. The
        fix runs only if the reproduce stage confirms the bug.
      </p>
      <ol className="flex flex-col gap-2">
        {groups.map((g) => (
          <li key={g.issueRef} className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2">
              {g.issueNumber != null && (
                <span className="font-mono text-xs text-muted-foreground">#{g.issueNumber}</span>
              )}
              <span className="truncate text-sm font-medium">{g.title}</span>
            </div>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{g.repo}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono">reproduce</span>
              <span className="text-muted-foreground">→</span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono">fix (gated)</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TaskRow({
  task,
  missionId,
  goalTemplate,
}: {
  task: Task;
  missionId: string;
  goalTemplate: string;
}) {
  const [removeState, removeAction, removePending] = useActionState(removeTaskAction, initial);
  const [varsState, varsAction, varsPending] = useActionState(updatePromptVarsAction, initial);
  const [expanded, setExpanded] = useState(false);

  // Memoized so the `?? {}` fallback doesn't allocate a fresh object every
  // render when promptVars is null — that fresh reference is a dependency of
  // the isDirty memo below, which would otherwise recompute on every render.
  const savedVars = useMemo(
    () => (task.promptVars ?? {}) as Record<string, unknown>,
    [task.promptVars],
  );
  const [localVars, setLocalVars] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(savedVars)) {
      out[k] = v === null || v === undefined ? '' : String(v);
    }
    return out;
  });

  // Extract variable names from the goal template
  const varNames = useMemo(() => {
    const names = new Set<string>();
    // matchAll iterates a clone, so it never *writes* the shared module-level
    // TEMPLATE_VAR_RE.lastIndex — no cross-component corruption when two
    // components render concurrently, unlike the exec() loop this replaced.
    // Note it does *read* lastIndex as its start offset. Safe here because the
    // regex's only other use is String.replace() above, which resets lastIndex
    // to 0 on both entry and exit; a stray exec()/test() would break that.
    for (const m of goalTemplate.matchAll(TEMPLATE_VAR_RE)) {
      names.add(m[1]!);
    }
    return Array.from(names);
  }, [goalTemplate]);

  // Custom vars are those not auto-populated (repo, base_branch)
  const customVarNames = useMemo(
    () => varNames.filter((n) => n !== 'repo' && n !== 'base_branch'),
    [varNames],
  );

  const preview = useMemo(
    () => renderPrompt(goalTemplate, { repo: task.repo, base_branch: task.baseBranch, ...localVars }),
    [goalTemplate, task.repo, task.baseBranch, localVars],
  );

  const isDirty = useMemo(() => {
    for (const k of Object.keys(localVars)) {
      if (String(savedVars[k] ?? '') !== localVars[k]) return true;
    }
    return false;
  }, [localVars, savedVars]);

  const handleVarChange = useCallback((key: string, value: string) => {
    setLocalVars((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <li className="rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-semibold">{task.repo}</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{task.baseBranch}</span>
            <span>·</span>
            <span className="font-mono">queued</span>
            {customVarNames.length > 0 && (
              <>
                <span>·</span>
                <span>{customVarNames.length} custom {customVarNames.length === 1 ? 'var' : 'vars'}</span>
              </>
            )}
          </div>
          {(removeState as { error?: string }).error ? (
            <p className="mt-1 text-xs text-destructive">{(removeState as { error?: string }).error}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? 'Collapse' : 'Edit prompt'}
          </Button>
          <form action={removeAction}>
            <input type="hidden" name="missionId" value={missionId} />
            <input type="hidden" name="taskId" value={task.id} />
            <Button type="submit" variant="ghost" size="sm" disabled={removePending}>
              {removePending ? <Spinner data-icon="inline-start" /> : null}
              Remove
            </Button>
          </form>
        </div>
      </div>

      {expanded && (
        <div className="flex flex-col gap-3 border-t px-4 py-3">
          {customVarNames.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">Template variables</p>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {customVarNames.map((name) => (
                  <div key={name}>
                    <Label htmlFor={`var-${task.id}-${name}`} className="text-xs font-mono">
                      {`{{${name}}}`}
                    </Label>
                    <Input
                      id={`var-${task.id}-${name}`}
                      value={localVars[name] ?? ''}
                      onChange={(e) => handleVarChange(name, e.target.value)}
                      className="mt-1 font-mono text-xs"
                      placeholder={name}
                    />
                  </div>
                ))}
              </div>
              {isDirty && (
                <form action={varsAction}>
                  <input type="hidden" name="missionId" value={missionId} />
                  <input type="hidden" name="taskId" value={task.id} />
                  <input
                    type="hidden"
                    name="promptVars"
                    value={JSON.stringify({
                      repo: task.repo,
                      base_branch: task.baseBranch,
                      ...localVars,
                    })}
                  />
                  <Button type="submit" size="sm" disabled={varsPending}>
                    {varsPending ? <Spinner data-icon="inline-start" /> : null}
                    Save variables
                  </Button>
                  {(varsState as { error?: string }).error ? (
                    <span className="ml-2 text-xs text-destructive">
                      {(varsState as { error?: string }).error}
                    </span>
                  ) : null}
                </form>
              )}
            </div>
          )}

          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Rendered prompt preview</p>
            <Textarea
              readOnly
              value={preview}
              className="min-h-[80px] resize-none bg-muted/50 font-mono text-xs"
              rows={Math.min(10, Math.max(3, preview.split('\n').length))}
            />
          </div>
        </div>
      )}
    </li>
  );
}
