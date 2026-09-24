/**
 * THE NESTING CAP, in one place (t-h8s3xg).
 *
 * `subagent_depth` (default 1) is how many levels of sub-agent the engine will
 * run. With the default, a child session is ALREADY at the cap: it can never
 * spawn. The runtime check in `tool/task.ts` has always said so, but the child
 * was still OFFERED the tool - the owner's `agent.general.permission.task:
 * allow` (written by the Tools ledger) lifts the default deny and
 * `tool_search.always: [task]` pins it loaded - so the model called it and read
 * a limit error it could do nothing about.
 *
 * The fix is absence, not a better error: `session/tools.ts` drops these three
 * ids from the catalog of a session already at the cap, the same treatment an
 * OFF tool gets, so neither a schema nor a `tool_search` line is spent on a
 * tool that cannot run. `tool/task.ts` keeps its check as the backstop.
 *
 * PURE on purpose - no Session read, no Effect: `acp/subagent-tools.ts` is a
 * projection with no engine behind it and must stay importable from a test
 * that boots nothing. The one caller that needs the live chain walks it itself.
 */

export const NESTED_TASK_TOOLS: readonly string[] = ["task", "task_list", "task_stop"]

export const DEFAULT_DEPTH = 1

/** True when a session at `depth` may not spawn. `depth` is 0 for a top-level
 *  chat, 1 for its child, and so on. */
export function atCap(depth: number, configured: number | undefined): boolean {
  return depth >= (configured ?? DEFAULT_DEPTH)
}

/** What a model at the cap reads when it calls `task` anyway - the owner's
 *  terms, not the config key's. Kept beside `atCap` so the rule and the
 *  sentence cannot drift apart. */
export function capMessage(configured: number | undefined): string {
  return `This agent is already a sub-agent and nested sub-agents are off (subagent_depth ${configured ?? DEFAULT_DEPTH}). Finish the work yourself or report back to the parent.`
}

/** The reason the Tools ledger prints in a cell it has greyed out. */
export const LEDGER_REASON = "nested sub-agents need subagent_depth ≥ 2"

export * as SubagentDepth from "./subagent-depth"
