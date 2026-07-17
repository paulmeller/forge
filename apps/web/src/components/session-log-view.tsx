'use client';

import { useEffect, useRef, useState } from 'react';

import { formatLogLine, normalizeRawSessionEvent, type LogEventLike } from '@/lib/session-log-format';
import { cn } from '@/lib/utils';

type LogEvent = LogEventLike & { id: string; createdAt: Date | string };

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
  const [events, setEvents] = useState<LogEvent[]>(initialEvents);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEvents(initialEvents);
    // Only re-seed when the task changes — live events accumulate on top
    // independently, and initialEvents is a snapshot taken once per render
    // of the parent, not a dependency we want to re-trigger on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

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
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  const visible = typeof maxLines === 'number' ? events.slice(-maxLines) : events;

  return (
    <div
      ref={containerRef}
      className={cn('overflow-y-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed', className)}
    >
      {visible.length === 0 ? (
        <p className="text-muted-foreground">No activity yet.</p>
      ) : (
        visible.map((event) => (
          <div key={event.id} className="whitespace-pre-wrap break-words">
            {formatLogLine(event)}
          </div>
        ))
      )}
    </div>
  );
}
