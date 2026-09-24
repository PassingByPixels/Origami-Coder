// runningChildren.ts — host half of the sidebar ring's "sub-agents running" state, a pure leaf over
// DashboardPanel's per-session Set.
// Mirrors subagentEntry.ts's `stillOut` rule so the two "is this agent still out" answers can never
// disagree.

/** The onToolCallUpdate riders that name a still-live BACKGROUND spawn. */
export interface SpawnArgs {
  toolName?: string;
  taskBackground?: boolean;
  taskSessionId?: string;
}

/** Record a spawn; a no-op for a foreground task, a missing child id, or re-recording an
 *  already-tracked child. */
export function recordSpawn(children: Set<string>, args: SpawnArgs): void {
  if (args.toolName === 'task' && args.taskBackground === true && args.taskSessionId) {
    children.add(args.taskSessionId);
  }
}
