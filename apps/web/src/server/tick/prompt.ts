/** Template substitution: {{var}} → vars.var (missing → empty string). */
export function renderPrompt(goal: string, vars: Record<string, unknown>): string {
  return goal.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * Substitute only Forge-owned placeholders, leaving every other `{{token}}`
 * exactly as written.
 *
 * Unlike renderPrompt, this runs over content Forge does not own —
 * a target repository's own AGENTS.md, fetched live at dispatch. That file may
 * legitimately contain `{{word}}` text of its own (Handlebars, Jinja and Vue
 * examples, or docs about templating), and renderPrompt maps every unknown key
 * to an empty string, which would silently delete it from the instructions the
 * agent reads. Only the keys named here are replaced.
 */
export function renderOwnedVars(
  content: string,
  vars: Record<string, unknown>,
  ownedKeys: readonly string[],
): string {
  return content.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    if (!ownedKeys.includes(key)) return match;
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
  });
}
