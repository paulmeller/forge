'use client';

import { useMemo, useState } from 'react';

import { formatLogLine, isToolEvent } from '@/lib/session-log-format';
import type { LedgerEvent, ReproduceVerdict } from '@forge/db';

type FileTab = 'prompt.txt' | 'agent.log' | 'console.log' | 'status.json';

export function TaskFileTabs({
  promptVars,
  status,
  verdict,
  ledger,
}: {
  promptVars: Record<string, unknown> | null;
  status: string;
  verdict: ReproduceVerdict | null;
  ledger: LedgerEvent[];
}) {
  const chronological = useMemo(() => [...ledger].reverse(), [ledger]);
  const hasToolEvents = useMemo(() => chronological.some(isToolEvent), [chronological]);

  const tabs: FileTab[] = [
    'prompt.txt',
    'agent.log',
    ...(hasToolEvents ? (['console.log'] as const) : []),
    'status.json',
  ];
  const [active, setActive] = useState<FileTab>('agent.log');

  const content = (() => {
    switch (active) {
      case 'prompt.txt':
        return JSON.stringify(promptVars ?? {}, null, 2);
      case 'agent.log':
        return chronological.map((e) => formatLogLine(e)).join('\n') || 'No activity yet.';
      case 'console.log':
        return (
          chronological.filter(isToolEvent).map((e) => formatLogLine(e)).join('\n') ||
          'No tool activity yet.'
        );
      case 'status.json':
        return JSON.stringify({ status, verdict }, null, 2);
    }
  })();

  return (
    <div className="rounded-md border">
      <div className="flex gap-1 border-b bg-muted/30 px-2 pt-2">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActive(tab)}
            className={`rounded-t px-3 py-1.5 font-mono text-xs ${
              active === tab
                ? 'border border-b-0 bg-background text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>
      <pre className="max-h-[400px] overflow-auto p-3 font-mono text-xs leading-relaxed">
        {content}
      </pre>
    </div>
  );
}
