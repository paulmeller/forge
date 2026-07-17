'use client';

import { useMemo, useState } from 'react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatLogLine, isToolEvent } from '@/lib/session-log-format';
import type { Task } from '@forge/db';

type LedgerRow = { id: string; eventType: string; payload: unknown; createdAt: Date };

type FileEntry = { name: string; content: string; modifiedAt: Date; sizeBytes: number };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Same synthesized files TaskFileTabs already computes for the Task detail
 * page (prompt.txt/agent.log/console.log/status.json), rendered here as a
 * Name/Modified/Size table matching the operator-console reference instead
 * of a tab bar. No new data source — same ledger/promptVars/verdict inputs.
 */
export function AttemptFileBrowser({ task, ledger }: { task: Task; ledger: LedgerRow[] }) {
  const [openFile, setOpenFile] = useState<string | null>(null);

  const chronological = useMemo(() => [...ledger].reverse(), [ledger]);
  const hasToolEvents = useMemo(() => chronological.some(isToolEvent), [chronological]);
  const latestEventAt = chronological.at(-1)?.createdAt ?? task.updatedAt;

  const files: FileEntry[] = useMemo(() => {
    const promptContent = JSON.stringify(task.promptVars ?? {}, null, 2);
    const agentLogContent =
      chronological.map((e) => formatLogLine(e)).join('\n') || 'No activity yet.';
    const statusContent = JSON.stringify({ status: task.status, verdict: task.verdict }, null, 2);

    const entries: FileEntry[] = [
      {
        name: 'prompt.txt',
        content: promptContent,
        modifiedAt: task.dispatchedAt ?? task.createdAt,
        sizeBytes: new Blob([promptContent]).size,
      },
      {
        name: 'agent.log',
        content: agentLogContent,
        modifiedAt: latestEventAt,
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
        modifiedAt: latestEventAt,
        sizeBytes: new Blob([consoleContent]).size,
      });
    }
    entries.push({
      name: 'status.json',
      content: statusContent,
      modifiedAt: task.updatedAt,
      sizeBytes: new Blob([statusContent]).size,
    });
    return entries;
  }, [task, chronological, hasToolEvents, latestEventAt]);

  const selected = files.find((f) => f.name === openFile) ?? null;

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Modified</TableHead>
            <TableHead className="text-right">Size</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((f) => (
            <TableRow
              key={f.name}
              onClick={() => setOpenFile(openFile === f.name ? null : f.name)}
              className="cursor-pointer"
            >
              <TableCell className="font-mono text-xs">{f.name}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Intl.DateTimeFormat(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: 'numeric',
                }).format(f.modifiedAt)}
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                {formatSize(f.sizeBytes)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {selected ? (
        <pre className="max-h-[300px] overflow-auto border-t p-3 font-mono text-xs leading-relaxed">
          {selected.content}
        </pre>
      ) : null}
    </div>
  );
}
