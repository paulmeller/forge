export type EventRole = 'forge' | 'session' | 'agent' | 'model';

const ROLE_BY_PREFIX: Array<[string, EventRole]> = [
  ['planner.', 'forge'],
  ['mission.', 'forge'],
  ['dispatcher.', 'forge'],
  ['task.', 'forge'],
  ['ci.', 'forge'],
  ['session.', 'session'],
  ['span.model_request', 'model'],
  ['agent.', 'agent'],
  ['user.', 'agent'],
];

export function roleOf(eventType: string): EventRole {
  for (const [prefix, role] of ROLE_BY_PREFIX) {
    if (eventType.startsWith(prefix)) return role;
  }
  return 'forge';
}

/** Whether the event should be expanded by default in the timeline. */
export function shouldExpandByDefault(eventType: string): boolean {
  if (eventType === 'agent.thinking') return false;
  if (eventType === 'agent.tool_use' || eventType === 'agent.tool_result') return false;
  if (eventType.startsWith('span.')) return false;
  if (eventType === 'session.status_running' || eventType === 'session.status_idle') return false;
  return true;
}

const LABEL_OVERRIDES: Record<string, string> = {
  'span.model_request_start': 'request_start',
  'span.model_request_end': 'request_end',
};

/** Short, human-friendly label — drops the role prefix where possible. */
export function shortLabel(eventType: string): string {
  if (LABEL_OVERRIDES[eventType]) return LABEL_OVERRIDES[eventType];
  for (const [prefix] of ROLE_BY_PREFIX) {
    if (eventType.startsWith(prefix)) {
      const rest = eventType.slice(prefix.length);
      return rest.length > 0 ? rest : eventType;
    }
  }
  return eventType;
}

const PR_URL_RE = /https:\/\/github\.com\/[^\s"'/]+\/[^\s"'/]+\/pull\/(\d+)/;
export function extractPrUrl(payload: unknown): { url: string; number: number } | null {
  if (!payload || typeof payload !== 'object') return null;
  const seen = new Set<unknown>();
  const stack: unknown[] = [payload];
  while (stack.length) {
    const v = stack.pop();
    if (v == null || seen.has(v)) continue;
    seen.add(v);
    if (typeof v === 'string') {
      const m = PR_URL_RE.exec(v);
      if (m) return { url: m[0], number: Number(m[1]) };
    } else if (Array.isArray(v)) {
      for (const e of v) stack.push(e);
    } else if (typeof v === 'object') {
      for (const k of Object.keys(v as object)) stack.push((v as Record<string, unknown>)[k]);
    }
  }
  return null;
}
