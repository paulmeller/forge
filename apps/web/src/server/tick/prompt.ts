/** Template substitution: {{var}} → vars.var (missing → empty string). */
export function renderPrompt(goal: string, vars: Record<string, unknown>): string {
  return goal.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}
