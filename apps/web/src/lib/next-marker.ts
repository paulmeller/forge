/** Add or remove one issueRef from a container's nextIssueRefs list, deduplicated. */
export function updateNextIssueRefs(
  current: string[] | null,
  issueRef: string,
  marked: boolean,
): string[] {
  const set = new Set(current ?? []);
  if (marked) set.add(issueRef);
  else set.delete(issueRef);
  return [...set];
}
