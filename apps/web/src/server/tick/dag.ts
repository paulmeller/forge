type TaskNode = {
  index: number;
  dependsOnIndices: number[];
};

type DagResult = { valid: true; error: null } | { valid: false; error: string };

/**
 * Validate that a list of tasks with index-based dependencies forms a DAG
 * (no cycles). Uses iterative DFS with a three-color marking scheme.
 */
export function validateDag(tasks: TaskNode[]): DagResult {
  const n = tasks.length;

  for (const task of tasks) {
    for (const dep of task.dependsOnIndices) {
      if (dep < 0 || dep >= n) {
        return { valid: false, error: `task ${task.index} depends on index ${dep} which is out of bounds (0-${n - 1})` };
      }
    }
  }

  const adj = new Map<number, number[]>();
  for (const task of tasks) {
    adj.set(task.index, task.dependsOnIndices);
  }

  // 0 = unvisited, 1 = visiting (in current DFS path), 2 = done
  const state = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    if (state[i] === 2) continue;
    const stack: Array<{ node: number; childIdx: number }> = [{ node: i, childIdx: 0 }];
    state[i] = 1;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const deps = adj.get(frame.node) ?? [];

      if (frame.childIdx >= deps.length) {
        state[frame.node] = 2;
        stack.pop();
        continue;
      }

      const child = deps[frame.childIdx]!;
      frame.childIdx += 1;

      if (state[child] === 1) {
        return { valid: false, error: `cycle detected involving task indices ${child} and ${frame.node}` };
      }
      if (state[child] === 0) {
        state[child] = 1;
        stack.push({ node: child, childIdx: 0 });
      }
    }
  }

  return { valid: true, error: null };
}
