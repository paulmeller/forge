/**
 * Renders both persisted Ledger events and live-streamed raw session events
 * as human-readable lines, using one formatter for both — a live event is
 * normalized into the same {eventType, payload} shape a persisted
 * LedgerEvent already has (backend-sourced ledger rows store the raw engine
 * event verbatim as `payload`), so this file never needs to know which
 * source an event came from.
 */

export type LogEventLike = {
  eventType: string;
  payload: unknown;
};

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function firstText(payload: unknown): string {
  const content = asRecord(payload).content;
  if (Array.isArray(content)) {
    const block = content.find(
      (c): c is { type: string; text?: string } =>
        !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text',
    );
    if (block && typeof block.text === 'string') return block.text;
  }
  return '';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Full (untruncated) text of the most recent `agent.message` event in a
 *  chronological (oldest→newest) ledger, or null if there isn't one yet. */
export function lastAssistantMessage(ledger: LogEventLike[]): string | null {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const event = ledger[i];
    if (!event || event.eventType !== 'agent.message') continue;
    const text = firstText(event.payload);
    if (text) return text;
  }
  return null;
}

export function formatLogLine(event: LogEventLike): string {
  const p = asRecord(event.payload);

  switch (event.eventType) {
    case 'agent.message':
      return `[assistant] ${truncate(firstText(event.payload), 300)}`;

    case 'agent.thinking':
      return '[thinking…]';

    case 'agent.tool_use': {
      const name = typeof p.name === 'string' ? p.name : 'tool';
      const input = asRecord(p.input);
      const description = typeof input.description === 'string' ? input.description : undefined;
      return description ? `[tool] ${name} — ${truncate(description, 120)}` : `[tool] ${name}`;
    }

    case 'agent.tool_result': {
      const content = asRecord(p.content);
      const exitCode = content.exitCode;
      const stdout = typeof content.stdout === 'string' ? content.stdout : undefined;
      if (typeof exitCode === 'number') {
        return stdout
          ? `[tool result] exit ${exitCode} — ${truncate(stdout, 120)}`
          : `[tool result] exit ${exitCode}`;
      }
      return p.is_error === true ? '[tool result] error' : '[tool result] ok';
    }

    case 'session.error': {
      const error = asRecord(p.error);
      const message = typeof error.message === 'string' ? error.message : 'unknown error';
      return `[error] ${message}`;
    }

    case 'session.status_running':
    case 'session.status_idle':
    case 'session.status_terminated':
      return `[session] ${event.eventType.replace('session.status_', '')}`;

    case 'user.message':
      return `[user] ${truncate(firstText(event.payload), 200)}`;

    default:
      return `[forge] ${event.eventType}`;
  }
}

export function isErrorLogEvent(event: LogEventLike): boolean {
  if (event.eventType === 'session.error') return true;
  if (event.eventType !== 'agent.tool_result') return false;
  const p = asRecord(event.payload);
  if (p.is_error === true) return true;
  const content = asRecord(p.content);
  return typeof content.exitCode === 'number' && content.exitCode !== 0;
}

export function isToolEvent(event: LogEventLike): boolean {
  return event.eventType === 'agent.tool_use' || event.eventType === 'agent.tool_result';
}

/**
 * Maps a raw engine SSE frame (the `data:` JSON of an /events/stream event —
 * shape: `{ id, type, seq, processed_at, ... }`) into the same
 * {id, eventType, payload, createdAt} shape a persisted LedgerEvent has, so
 * the rest of the app (formatLogLine, isToolEvent, list rendering) never
 * needs a separate code path for live vs. static events.
 */
export function normalizeRawSessionEvent(raw: unknown): {
  id: string;
  eventType: string;
  payload: unknown;
  createdAt: Date;
} {
  const r = asRecord(raw);
  const id = typeof r.id === 'string' ? r.id : `live_${Math.random().toString(36).slice(2)}`;
  const eventType = typeof r.type === 'string' ? r.type : 'unknown';
  const createdAt = typeof r.processed_at === 'string' ? new Date(r.processed_at) : new Date();
  return { id, eventType, payload: raw, createdAt };
}
