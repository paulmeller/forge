'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import type { TaskRollup } from '@/components/progress-pill';
import type { WorkspaceIssueRow } from '@/lib/workspace-issues';

import { toggleNextMarker } from './actions';
import { IssueRunPanel } from './issue-run-panel';
import { WorkOnItButton } from './work-on-it-button';

const TERMINAL_HEADLINES = new Set(['fixed', 'not_reproduced', 'fix_skipped', 'failed']);
const RUNNING_HEADLINES = new Set(['reproducing', 'fixing']);

export function WorkspaceList({
  repo,
  rows,
  missionId,
  ledgersByTaskId,
  taskRollupsByTaskId,
  nextIssueRefs,
  initialIssueNumber = null,
}: {
  repo: string;
  rows: WorkspaceIssueRow[];
  missionId: string | null;
  ledgersByTaskId: Record<
    string,
    Array<{ id: string; eventType: string; payload: unknown; createdAt: Date }>
  >;
  taskRollupsByTaskId: Record<string, TaskRollup>;
  nextIssueRefs: string[];
  /** Pre-select a specific issue (e.g. deep-linked from the missions table) instead of defaulting to the first row. */
  initialIssueNumber?: number | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [selectedNumber, setSelectedNumber] = useState<number | null>(
    initialIssueNumber ?? rows[0]?.issue.number ?? null,
  );
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
  const initialRow =
    initialIssueNumber != null ? rows.find((r) => r.issue.number === initialIssueNumber) : null;
  const [showInactive, setShowInactive] = useState(
    !!(
      initialRow?.group &&
      TERMINAL_HEADLINES.has(initialRow.group.headline) &&
      !nextIssueRefs.includes(`${initialRow.issue.repo}#${initialRow.issue.number}`)
    ),
  );
  const [pending, startTransition] = useTransition();

  const allLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const row of rows) {
      for (const label of row.issue.labels ?? []) labels.add(label);
    }
    return [...labels].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const toggleLabel = (label: string) => {
    setSelectedLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesQuery =
        !q || r.issue.title.toLowerCase().includes(q) || String(r.issue.number).includes(q);
      if (!matchesQuery) return false;
      if (selectedLabels.size === 0) return true;
      const issueLabels = new Set(r.issue.labels ?? []);
      return [...selectedLabels].every((label) => issueLabels.has(label));
    });
  }, [rows, query, selectedLabels]);

  function issueRefFor(row: WorkspaceIssueRow): string {
    return `${row.issue.repo}#${row.issue.number}`;
  }

  const nextSet = new Set(nextIssueRefs);
  const nextRows = filtered.filter((r) => nextSet.has(issueRefFor(r)));
  const inactiveRows = filtered.filter(
    (r) => r.group && TERMINAL_HEADLINES.has(r.group.headline) && !nextSet.has(issueRefFor(r)),
  );
  const workingRows = filtered.filter(
    (r) => !nextSet.has(issueRefFor(r)) && !(r.group && TERMINAL_HEADLINES.has(r.group.headline)),
  );

  const selected = filtered.find((r) => r.issue.number === selectedNumber) ?? filtered[0] ?? null;

  function handleToggleNext(row: WorkspaceIssueRow, marked: boolean) {
    startTransition(async () => {
      const result = await toggleNextMarker(repo, issueRefFor(row), marked);
      if (!result.ok) return;
      router.refresh();
    });
  }

  function renderRow(row: WorkspaceIssueRow) {
    const ref = issueRefFor(row);
    return (
      <div
        key={row.issue.number}
        className={`flex items-center gap-1 border-b px-1 last:border-b-0 ${
          selected?.issue.number === row.issue.number ? 'bg-accent' : ''
        }`}
      >
        <button
          type="button"
          onClick={() => setSelectedNumber(row.issue.number)}
          className="flex-1 py-2 text-left text-sm hover:bg-accent"
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">#{row.issue.number}</span>
            {row.group ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                {RUNNING_HEADLINES.has(row.group.headline) ? (
                  <span
                    className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"
                    aria-hidden
                  />
                ) : null}
                {row.group.headline}
              </span>
            ) : null}
          </div>
          <p className="truncate">{row.issue.title}</p>
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => handleToggleNext(row, !nextSet.has(ref))}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={nextSet.has(ref) ? 'Remove from Next' : 'Mark as Next'}
        >
          {nextSet.has(ref) ? '★' : '☆'}
        </button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No open issues in {repo}.</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="grid h-full grid-cols-[320px_1fr] gap-4">
      <div className="flex h-full min-h-0 flex-col rounded-lg border">
        <div className="shrink-0 border-b p-2">
          <Input
            placeholder="Search issues…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {allLabels.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {allLabels.map((label) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleLabel(label)}
                  aria-pressed={selectedLabels.has(label)}
                >
                  <Badge variant={selectedLabels.has(label) ? 'default' : 'outline'}>
                    {label}
                  </Badge>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {nextRows.length > 0 ? (
            <>
              <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Next
              </p>
              {nextRows.map(renderRow)}
            </>
          ) : null}

          <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Working
          </p>
          {workingRows.length > 0 ? (
            workingRows.map(renderRow)
          ) : (
            <p className="px-3 py-2 text-xs text-muted-foreground">Nothing in progress.</p>
          )}

          {inactiveRows.length > 0 ? (
            <div className="border-t">
              <button
                type="button"
                onClick={() => setShowInactive((v) => !v)}
                className="w-full px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                {showInactive ? '▾' : '▸'} Inactive ({inactiveRows.length})
              </button>
              {showInactive ? inactiveRows.map(renderRow) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex h-full min-h-0 flex-col">
        {selected ? (
          <>
            <div className="mb-3 shrink-0">
              <h2 className="text-lg font-medium">
                #{selected.issue.number} {selected.issue.title}
              </h2>
              <a
                href={selected.issue.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground underline underline-offset-2"
              >
                View on GitHub
              </a>
            </div>
            <div className="min-h-0 min-w-0 flex-1">
              {selected.group && missionId ? (
                <IssueRunPanel
                  group={selected.group}
                  missionId={missionId}
                  ledgersByTaskId={ledgersByTaskId}
                  taskRollupsByTaskId={taskRollupsByTaskId}
                />
              ) : (
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {selected.issue.body || 'No description.'}
                </p>
              )}
            </div>
            <div className="mt-3 shrink-0">
              <WorkOnItButton
                repo={repo}
                issue={selected.issue}
                headline={selected.group?.headline ?? null}
              />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No issue matches your search.</p>
        )}
      </div>
    </div>
  );
}
