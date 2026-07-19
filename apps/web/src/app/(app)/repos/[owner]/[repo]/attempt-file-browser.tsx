'use client';

import { useMemo, useState } from 'react';

import { formatLogLine, isToolEvent } from '@/lib/session-log-format';
import { cn } from '@/lib/utils';
import type { Task } from '@forge/db';

type LedgerRow = { id: string; eventType: string; payload: unknown; createdAt: Date };

type FileEntry = { name: string; content: string; sizeBytes: number };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Same synthesized files TaskFileTabs already computes for the Task detail
 * page (prompt.txt/agent.log/console.log/status.json), rendered here as a
 * compact IDE-file-tree-style list (name + size, click to preview) rather
 * than a data table. No new data source — same ledger/promptVars/verdict
 * inputs.
 */
export function AttemptFileBrowser({ task, ledger }: { task: Task; ledger: LedgerRow[] }) {
  const [openFile, setOpenFile] = useState<string | null>(null);

  // `ledger` is already chronological (oldest→newest) by the time it reaches
  // this component: page.tsx pre-reverses the newest-first rows returned by
  // listLedgerForTask before storing them in ledgersByTaskId. No further
  // reverse is needed here (unlike TaskFileTabs, which receives raw
  // newest-first ledger rows and does exactly one reverse).
  const chronological = ledger;
  const hasToolEvents = useMemo(() => chronological.some(isToolEvent), [chronological]);

  const files: FileEntry[] = useMemo(() => {
    const promptContent = JSON.stringify(task.promptVars ?? {}, null, 2);
    const agentLogContent =
      chronological.map((e) => formatLogLine(e)).join('\n') || 'No activity yet.';
    const statusContent = JSON.stringify({ status: task.status, verdict: task.verdict }, null, 2);

    const entries: FileEntry[] = [
      {
        name: 'prompt.txt',
        content: promptContent,
        sizeBytes: new Blob([promptContent]).size,
      },
      {
        name: 'agent.log',
        content: agentLogContent,
        sizeBytes: new Blob([agentLogContent]).size,
      },
    ];
    if (hasToolEvents) {
      const consoleContent =
        chronological.filter(isToolEvent).map((e) => formatLogLine(e)).join('\n') ||
        'No tool activity yet.';
      entries.push({
        name: 'console.log',
        content: consoleContent,
        sizeBytes: new Blob([consoleContent]).size,
      });
    }
    entries.push({
      name: 'status.json',
      content: statusContent,
      sizeBytes: new Blob([statusContent]).size,
    });
    return entries;
  }, [task, chronological, hasToolEvents]);

  const selected = files.find((f) => f.name === openFile) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="min-h-0 flex-1 overflow-y-auto p-1">
        {files.map((f) => (
          <button
            key={f.name}
            type="button"
            onClick={() => setOpenFile(openFile === f.name ? null : f.name)}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent',
              openFile === f.name && 'bg-accent',
            )}
          >
            <span className="truncate font-mono">{f.name}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {formatSize(f.sizeBytes)}
            </span>
          </button>
        ))}
      </nav>
      {selected ? (
        <pre className="max-h-[50%] shrink-0 overflow-auto border-t p-3 font-mono text-xs leading-relaxed">
          {selected.content}
        </pre>
      ) : null}
    </div>
  );
}
