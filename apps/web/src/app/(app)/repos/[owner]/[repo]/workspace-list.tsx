'use client';

import { useMemo, useState } from 'react';

import { IssueTriageCard } from '@/components/issue-triage-card';
import { Input } from '@/components/ui/input';
import type { WorkspaceIssueRow } from '@/lib/workspace-issues';

import { WorkOnItButton } from './work-on-it-button';

export function WorkspaceList({
  repo,
  rows,
  missionId,
}: {
  repo: string;
  rows: WorkspaceIssueRow[];
  missionId: string | null;
}) {
  const [query, setQuery] = useState('');
  const [selectedNumber, setSelectedNumber] = useState<number | null>(rows[0]?.issue.number ?? null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.issue.title.toLowerCase().includes(q) || String(r.issue.number).includes(q),
    );
  }, [rows, query]);

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
              <IssueTriageCard group={selected.group} missionId={missionId} />
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
