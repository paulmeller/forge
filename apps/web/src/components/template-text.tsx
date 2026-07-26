import { Fragment } from 'react';

const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Renders text with `{{var}}` template variables highlighted as inline chips.
 * Preserves whitespace and newlines.
 */
export function TemplateText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  // matchAll iterates a clone, so it never *writes* the shared module-level
  // TEMPLATE_VAR_RE.lastIndex — no cross-component corruption when two
  // components render concurrently, unlike the exec() loop this replaced.
  // Note it does *read* lastIndex as its start offset, so this is only safe
  // while nothing in this module leaves it non-zero; matchAll is currently
  // the regex's only use here. Add an exec()/test() call and leading matches
  // would start being skipped.
  for (const match of text.matchAll(TEMPLATE_VAR_RE)) {
    if (match.index > lastIndex) {
      parts.push(<Fragment key={`t${key++}`}>{text.slice(lastIndex, match.index)}</Fragment>);
    }
    parts.push(
      <span
        key={`v${key++}`}
        className="mx-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground/80"
      >
        {match[1]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(<Fragment key={`t${key++}`}>{text.slice(lastIndex)}</Fragment>);
  }

  return <p className="whitespace-pre-wrap text-sm">{parts}</p>;
}
