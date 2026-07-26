'use client';

import { useEffect, useRef, useState } from 'react';

import type { EventRole } from '@/lib/event-roles';
import { roleOf } from '@/lib/event-roles';
import { formatConsoleTime } from '@/lib/format';
import {
  formatLogLine,
  isErrorLogEvent,
  normalizeRawSessionEvent,
  type LogEventLike,
} from '@/lib/session-log-format';
import { cn } from '@/lib/utils';

type LogEvent = LogEventLike & { id: string; createdAt: Date | string };

const ROLE_TAG_CLASS: Record<EventRole, string> = {
  forge: 'text-foreground',
  session: 'text-live',
  agent: 'text-warning',
  model: 'text-muted-foreground',
};

const LINE_RE = /^(\[[^\]]+\])(.*)$/s;

const PIN_THRESHOLD_PX = 24;

export function SessionLogView({
  taskId,
  isLive,
  initialEvents,
  maxLines,
  className,
}: {
  taskId: string;
  isLive: boolean;
  initialEvents: LogEvent[];
  maxLines?: number;
  className?: string;
}) {
  // All state below is seeded once from props and never re-synced on a
  // `taskId` change from within this component — callers must render this
  // component with `key={taskId}` (as both call sites do) so switching tasks
  // fully remounts it with fresh initial state, rather than updating an
  // existing instance in place via an effect.
  const [events, setEvents] = useState<LogEvent[]>(initialEvents);
  const [newCount, setNewCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const prevLengthRef = useRef(initialEvents.length);
  const forceScrollRef = useRef(true);

  useEffect(() => {
    if (!isLive) return;
    const source = new EventSource(`/api/tasks/${taskId}/stream`);
    source.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as unknown;
        const normalized = normalizeRawSessionEvent(parsed);
        setEvents((prev) => [...prev, normalized]);
      } catch {
        // Malformed frame (e.g. a keepalive comment surfaced as a message in
        // some browsers) — drop it rather than crash the view.
      }
    };
    return () => source.close();
  }, [taskId, isLive]);

  useEffect(() => {
    const el = containerRef.current;
    const delta = events.length - prevLengthRef.current;
    prevLengthRef.current = events.length;
    if (!el) return;
    if (forceScrollRef.current) {
      el.scrollTop = el.scrollHeight;
      forceScrollRef.current = false;
      return;
    }
    if (delta <= 0) return;
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setNewCount((n) => n + delta);
    }
  }, [events]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
    pinnedRef.current = atBottom;
    if (atBottom) setNewCount(0);
  }

  function scrollToBottom() {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setNewCount(0);
  }

  const visible = typeof maxLines === 'number' ? events.slice(-maxLines) : events;

  return (
    <div className={cn('relative overflow-hidden rounded-md border bg-muted/40', className)}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto p-3 font-mono text-xs leading-relaxed"
      >
        {visible.length === 0 ? (
          <p className="text-muted-foreground">No activity yet.</p>
        ) : (
          visible.map((event) => {
            const line = formatLogLine(event);
            const match = LINE_RE.exec(line);
            const tag = match ? match[1] : line;
            const rest = match ? match[2] : '';
            const tagClass = isErrorLogEvent(event)
              ? 'text-destructive'
              : ROLE_TAG_CLASS[roleOf(event.eventType)];
            return (
              <div key={event.id} className="console-line-in whitespace-pre-wrap break-words">
                <span className="mr-2 text-muted-foreground">
                  {formatConsoleTime(new Date(event.createdAt))}
                </span>
                <span className={tagClass}>{tag}</span>
                {rest}
              </div>
            );
          })
        )}
        {isLive ? (
          <span className="console-cursor text-live" aria-hidden>
            ▍
          </span>
        ) : null}
      </div>
      {newCount > 0 ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-2 right-2 rounded-full bg-foreground px-2.5 py-1 text-[11px] font-medium text-background shadow-sm hover:opacity-90"
        >
          ↓ {newCount} new
        </button>
      ) : null}
    </div>
  );
}
