import type { ReproduceVerdict } from '@forge/db';

/**
 * The reproduce→fix gate hinges on a machine-readable verdict the reproduce
 * agent emits at the end of its turn. The bug-reproduce skill instructs the
 * agent to print a fenced block:
 *
 *   ```forge-verdict
 *   { "reproduced": true, "summary": "...", "affectedVersions": {"v5.0": true},
 *     "evidence": "test/foo.test.ts fails on assert" }
 *   ```
 *
 * Forge parses the LAST such block from the reproduce Task's agent messages,
 * lifts it onto the Task, and gates the dependent fix Task on `reproduced`.
 */

const VERDICT_BLOCK_RE = /```forge-verdict\s*\n([\s\S]*?)```/g;

/** Parse a single verdict from arbitrary agent text. Returns the last valid block, or null. */
export function parseVerdict(text: string): ReproduceVerdict | null {
  let match: RegExpExecArray | null;
  let last: ReproduceVerdict | null = null;
  VERDICT_BLOCK_RE.lastIndex = 0;
  while ((match = VERDICT_BLOCK_RE.exec(text)) !== null) {
    const parsed = coerceVerdict(match[1]!);
    if (parsed) last = parsed;
  }
  return last;
}

function coerceVerdict(raw: string): ReproduceVerdict | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.reproduced !== 'boolean') return null;
  const verdict: ReproduceVerdict = {
    reproduced: o.reproduced,
    summary: typeof o.summary === 'string' ? o.summary : '',
  };
  if (o.affectedVersions && typeof o.affectedVersions === 'object') {
    const versions: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(o.affectedVersions as Record<string, unknown>)) {
      if (typeof v === 'boolean') versions[k] = v;
    }
    if (Object.keys(versions).length > 0) verdict.affectedVersions = versions;
  }
  if (typeof o.evidence === 'string') verdict.evidence = o.evidence;
  return verdict;
}

type LedgerRow = { eventType: string; payload: unknown };

/**
 * Walk a reproduce Task's ledger events oldest→newest, collecting the text of
 * every `agent.message`, and return the last verdict found across all of them.
 * Mirrors the agent-message text extraction used elsewhere (state.ts): the raw
 * payload carries `content: [{ type: 'text', text }]`.
 */
export function extractVerdictFromLedger(rows: LedgerRow[]): ReproduceVerdict | null {
  let last: ReproduceVerdict | null = null;
  for (const row of rows) {
    if (row.eventType !== 'agent.message') continue;
    for (const text of messageTexts(row.payload)) {
      const v = parseVerdict(text);
      if (v) last = v;
    }
  }
  return last;
}

function messageTexts(payload: unknown): string[] {
  const raw = payload as {
    content?: Array<{ type?: string; text?: string }>;
    message?: string;
  } | null;
  if (!raw) return [];
  const out: string[] = [];
  if (Array.isArray(raw.content)) {
    for (const block of raw.content) {
      if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text);
    }
  }
  if (typeof raw.message === 'string') out.push(raw.message);
  return out;
}
