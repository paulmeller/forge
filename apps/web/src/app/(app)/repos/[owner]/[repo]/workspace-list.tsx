'use client';

import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import type { WorkspaceIssueRow } from '@/lib/workspace-issues';

import { IssueRunPanel } from './issue-run-panel';
import { WorkOnItButton } from './work-on-it-button';

export function WorkspaceList({
  repo,
  rows,
  missionId,
  ledgersByTaskId,
}: {
  repo: string;
  rows: WorkspaceIssueRow[];
  missionId: string | null;
  ledgersByTaskId: Record<
    string,
    Array<{ id: string; eventType: string; payload: unknown; createdAt: Date }>
  >;
}) {
  const [query, setQuery] = useState('');
  const [selectedNumber, setSelectedNumber] = useState<number | null>(rows[0]?.issue.number ?? null);
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());

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

  const selected = filtered.find((r) => r.issue.number === selectedNumber) ?? filtered[0] ?? null;

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        No open issues in {repo}.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[320px_1fr] gap-4">
      <div className="rounded-lg border">
        <div className="border-b p-2">
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
        <div className="max-h-[70vh] overflow-y-auto">
          {filtered.map((row) => (
            <button
              key={row.issue.number}
              type="button"
              onClick={() => setSelectedNumber(row.issue.number)}
              className={`block w-full border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent ${
                selected?.issue.number === row.issue.number ? 'bg-accent' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  #{row.issue.number}
                </span>
                {row.group ? (
                  <span className="text-xs text-muted-foreground">{row.group.headline}</span>
                ) : null}
              </div>
              <p className="truncate">{row.issue.title}</p>
            </button>
          ))}
        </div>
      </div>

      <div>
        {selected ? (
          <div className="space-y-3">
            <div>
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
            {selected.group && missionId ? (
              <IssueRunPanel
                group={selected.group}
                missionId={missionId}
                reproduceLedger={
                  selected.group.reproduce
                    ? (ledgersByTaskId[selected.group.reproduce.id] ?? [])
                    : []
                }
                fixLedger={
                  selected.group.fix ? (ledgersByTaskId[selected.group.fix.id] ?? []) : []
                }
              />
            ) : (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {selected.issue.body || 'No description.'}
              </p>
            )}
            <WorkOnItButton
              repo={repo}
              issue={selected.issue}
              headline={selected.group?.headline ?? null}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No issue matches your search.</p>
        )}
      </div>
    </div>
  );
}
