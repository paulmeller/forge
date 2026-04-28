'use client';

import { useState } from 'react';

import { cn } from '@/lib/utils';
import {
  extractPrUrl,
  roleOf,
  shortLabel,
  shouldExpandByDefault,
  type EventRole,
} from '@/lib/event-roles';
import type { LedgerEvent } from '@forge/db';

const ROLE_STYLES: Record<EventRole, { label: string; chip: string; bar: string }> = {
  forge: {
    label: 'forge',
    chip: 'bg-foreground text-background',
    bar: 'bg-foreground',
  },
  session: {
    label: 'session',
    chip: 'bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-200',
    bar: 'bg-blue-500',
  },
  agent: {
    label: 'agent',
    chip: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
    bar: 'bg-amber-500',
  },
  model: {
    label: 'model',
    chip: 'bg-muted text-muted-foreground',
    bar: 'bg-muted-foreground/40',
  },
};

function formatTime(date: Date): string {
  // UTC HH:MM:SS — deterministic across server and client. Locale-aware
  // formatting causes hydration mismatches when server (Node) and browser
  // pick different locales (e.g. en-US "AM" vs en-AU "am").
  return date.toISOString().slice(11, 19) + 'Z';
}

function readPreview(event: LedgerEvent): string | null {
  const p = event.payload as Record<string, unknown> | null;
  if (!p) return null;
  // Agent text outputs
  if (Array.isArray(p.content)) {
    for (const block of p.content as Array<Record<string, unknown>>) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim();
        return text.length > 280 ? text.slice(0, 280) + '…' : text;
      }
    }
  }
  if (typeof p.text === 'string') return p.text.length > 280 ? p.text.slice(0, 280) + '…' : p.text;
  // Tool use: show tool name + first arg
  if (typeof p.name === 'string') {
    const input = p.input as Record<string, unknown> | undefined;
    if (input) {
      const firstArg = Object.values(input)[0];
      const argStr = typeof firstArg === 'string' ? firstArg : JSON.stringify(firstArg ?? '');
      return `${p.name}: ${argStr.slice(0, 200)}`;
    }
    return String(p.name);
  }
  // Forge meta events: show payload keys
  if (typeof p === 'object' && Object.keys(p).length > 0) {
    const summary = Object.entries(p)
      .filter(([k]) => k !== 'type' && k !== 'id' && k !== 'processed_at')
      .slice(0, 3)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 60)}`)
      .join(' · ');
    return summary || null;
  }
  return null;
}

export function RoleTaggedEvent({ event }: { event: LedgerEvent }) {
  const role = roleOf(event.eventType);
  const style = ROLE_STYLES[role];
  const label = shortLabel(event.eventType);
  const preview = readPreview(event);
  const pr = extractPrUrl(event.payload);
  const isPrCapture = !!pr && event.eventType === 'agent.mcp_tool_result';
  const [open, setOpen] = useState(shouldExpandByDefault(event.eventType));

  return (
    <li className="relative pl-6">
      <span
        className={cn(
          'absolute left-2 top-2.5 h-2 w-2 -translate-x-1/2 rounded-full',
          isPrCapture ? 'bg-emerald-500 ring-2 ring-emerald-200 dark:ring-emerald-900' : style.bar,
        )}
        aria-hidden
      />
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-baseline gap-2 text-left"
      >
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-mono tracking-tight', style.chip)}>
          {style.label}
        </span>
        <span className="font-mono text-xs font-semibold">
          {label}
          {isPrCapture && <span className="ml-1.5 text-emerald-700 dark:text-emerald-400">★ PR #{pr?.number}</span>}
        </span>
        {preview && !open ? (
          <span className="truncate text-xs text-muted-foreground">{preview}</span>
        ) : null}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {formatTime(event.createdAt)}
        </span>
      </button>
      {open ? (
        <div className="mt-1.5 ml-1 space-y-1">
          {preview && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{preview}</p>}
          {pr && (
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs underline decoration-dotted hover:no-underline"
            >
              {pr.url}
            </a>
          )}
          {event.payload && Object.keys(event.payload).length > 0 && (
            <details className="text-[10px] text-muted-foreground">
              <summary className="cursor-pointer select-none">raw</summary>
              <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 leading-snug">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </details>
          )}
          {event.sourceEventId && (
            <p className="font-mono text-[10px] text-muted-foreground/80">{event.sourceEventId}</p>
          )}
        </div>
      ) : null}
    </li>
  );
}
