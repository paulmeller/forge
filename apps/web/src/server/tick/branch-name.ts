/**
 * The branch Forge assigns to a task.
 *
 * Forge used to infer three things about an agent's output — whether it
 * pushed, which branch, and whether it was done — and each inference was a
 * defect. This name replaces all three: it is assigned before the agent runs,
 * so Forge can simply ask GitHub whether it exists rather than search for
 * something an agent chose.
 *
 * Derived from the task id rather than stored: nothing to keep in sync, and
 * the branch name alone identifies the task that produced it.
 */
export function forgeBranchName(taskId: string): string {
  return `forge/${taskId}`;
}
