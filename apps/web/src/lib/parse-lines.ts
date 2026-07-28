/**
 * Textarea → string list. Returns undefined (not []) for an empty box, so
 * an unset field is stored as omitted: an empty `allowedPathPatterns` would
 * otherwise mean "no path may change" and block every merge.
 */
export function parseLines(value: string): string[] | undefined {
  const lines = value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines : undefined;
}
