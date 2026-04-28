import { Fragment } from 'react';

const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Renders text with `{{var}}` template variables highlighted as inline chips.
 * Preserves whitespace and newlines.
 */
export function TemplateText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let key = 0;

  TEMPLATE_VAR_RE.lastIndex = 0;
  while ((match = TEMPLATE_VAR_RE.exec(text)) !== null) {
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
