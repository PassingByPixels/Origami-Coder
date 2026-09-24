import { PermissionV1 } from "@origami/core/v1/permission"
import { PermissionPresets } from "@/permission/presets"
import type { Agent } from "./agent"

/**
 * The close-everything rule - a deny that names neither a permission nor a
 * pattern. Matched exactly, not by wildcard: `{ "*", "C:\secret\*", deny }`
 * is a path guard the user wrote on purpose and still crosses to the child.
 */
function isBlanketDeny(rule: PermissionV1.Rule): boolean {
  return rule.action === "deny" && rule.permission === "*" && rule.pattern === "*"
}

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's external_directory rules, and its deny rules EXCEPT
 *    the blanket `{ permission: "*", pattern: "*", action: "deny" }`. A deny
 *    that NAMES something - a tool id (`bash`), or a path pattern under
 *    `external_directory` - is the user's deliberate "not in this chat", so it
 *    still binds the child. The blanket deny names nothing and is dropped: it
 *    has to be, because session/tools.ts merges the parent rules AFTER the
 *    child's own ruleset and Permission.evaluate takes the LAST match, so a
 *    forwarded blanket deny outranks every allow the child agent was defined
 *    with and leaves it with no tools at all. What a subagent may do is its own
 *    agent definition's decision.
 * 2. The parent session's auto-approve PRESET rules (Approve = auto / bypass).
 *    Ordinary allows still stop at the task boundary - that is the safety intent
 *    kept from upstream - but a preset is not an agent capability, it is the
 *    user's live "stop asking me" answer for this whole chat.
 *    `PermissionPresets.isOverride` is derived from the preset table, so only
 *    rules a preset could have written pass here.
 * 3. Default `todowrite`, `task`, `send_message`, `list_agents` and
 *    `side_quest` denies if the subagent's own ruleset doesn't already name
 *    them. `side_quest` (t-fijeld) writes into the owner's review list, which
 *    is the MAIN agent's to fill - the natives deny it by name, and this is
 *    what makes a file-defined sub-agent do the same. The peer tools reach
 *    ACROSS the delegation tree to unrelated sessions on this machine, and a
 *    subagent has no standing to interrupt a stranger; the result path never
 *    uses them, since tool/task.ts returns foreground work as the tool's own
 *    output and injects background work into the parent session.
 *
 *    Gated, not unconditional: an agent definition that NAMES a peer tool is the
 *    user deliberately authoring a reporter, and that opt-in wins. What it buys
 *    is unscoped - the tools take any address the broker resolves, so such a
 *    subagent can message any peer, not only its parent.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const names = (id: string) => input.subagent.permission.some((rule) => rule.permission === id)
  const canTask = names("task")
  const canTodo = names("todowrite")
  const canSend = names("send_message")
  const canList = names("list_agents")
  const canSideQuest = names("side_quest")
  return [
    ...input.parentSessionPermission.filter(
      (rule) =>
        rule.permission === "external_directory" ||
        (rule.action === "deny" && !isBlanketDeny(rule)) ||
        PermissionPresets.isOverride(rule),
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canSend ? [] : [{ permission: "send_message" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canList ? [] : [{ permission: "list_agents" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canSideQuest ? [] : [{ permission: "side_quest" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
