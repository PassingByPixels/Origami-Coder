import { PermissionV1 } from "@origami/core/v1/permission"
import { PermissionPresets } from "@/permission/presets"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. The parent session's auto-approve PRESET rules (Approve = auto / bypass).
 *    Ordinary allows still stop at the task boundary - that is the safety intent
 *    kept from upstream - but a preset is not an agent capability, it is the
 *    user's live "stop asking me" answer for this whole chat. Dropping it made
 *    YOLO silently stop at the first sub-agent, which is the opposite of what
 *    the user just pressed, and it asked them again from a session they cannot
 *    see. `PermissionPresets.isOverride` is derived from the preset table, so
 *    only rules a preset could have written pass here.
 * 3. Default `todowrite`, `task`, `send_message` and `list_agents` denies if
 *    the subagent's own ruleset doesn't already name them.
 *
 *    The peer tools are here for the same reason collab/seal.ts closes them on
 *    a room member: they reach ACROSS the delegation tree to unrelated sessions
 *    on this machine, and a subagent has no standing to interrupt a stranger.
 *    A parent asked for a RESULT, and the result path never uses them - tool/
 *    task.ts returns foreground work as the tool's own output and injects
 *    background work as a synthetic message into the parent session - so
 *    denying them cannot cost a subagent its way home.
 *
 *    Gated, not unconditional. Unlike a room - which is sealed by definition,
 *    because the shared stream IS the record - a task spawn is an ordinary
 *    delegation, so an agent definition that NAMES a peer tool is the user
 *    deliberately authoring a reporter, and that opt-in still wins. What it
 *    buys is unscoped: the tools take any address the broker resolves, so such
 *    a subagent can message any peer, not only its parent.
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
  return [
    ...input.parentSessionPermission.filter(
      (rule) =>
        rule.permission === "external_directory" || rule.action === "deny" || PermissionPresets.isOverride(rule),
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canSend ? [] : [{ permission: "send_message" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canList ? [] : [{ permission: "list_agents" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
