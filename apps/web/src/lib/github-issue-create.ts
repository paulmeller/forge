/** Same comma/newline-separated parsing convention used by RepoSelector for repo lists. */
export function parseLabelsInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type CreateIssueInput = { title: string; body?: string; labels?: string[] };
export type CreateIssuePayload = { title: string; body?: string; labels?: string[] };

/** Shapes a GitHub issue-creation request body, trimming and dropping empty optional fields. */
export function buildCreateIssuePayload(input: CreateIssueInput): CreateIssuePayload {
  const title = input.title.trim();
  const body = input.body?.trim();
  const labels = (input.labels ?? []).map((l) => l.trim()).filter(Boolean);

  const payload: CreateIssuePayload = { title };
  if (body) payload.body = body;
  if (labels.length > 0) payload.labels = labels;
  return payload;
}
