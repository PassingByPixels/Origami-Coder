import { PermissionV1 } from "@origami/core/v1/permission"
import { Permission } from "@/permission"
import { CollabParallel } from "./parallel"

/**
 * THE SEALS A ROOM APPLIES OVER A DEFINITION'S OWN PERMISSIONS.
 *
 * Two of them, composed the same way and applied at different moments:
 *
 *  - {@link ROOM_SEAL}, at child-session CREATE, for as long as the member is in
 *    the room. What a room closes no matter what.
 *  - {@link COUNCIL_SEAL}, for the length of ONE council round turn and then
 *    undone. What a round closes because it dispatches wide.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ROOM SEAL.
 *
 * A bot carries its own permissions and can be invited into a room. The room
 * has invariants of its own, and until now they lived only in the YAML the
 * extension's CRUD writer stamped into each seed definition
 * (collabPresets.ts) — so a hand-written definition, or a Folds archetype used
 * as a room member, joined with none of them.
 *
 * This is the engine's copy, applied to every collab child session whatever the
 * definition says:
 *
 *  - `task` and `todowrite` DENY. Delegation inside a room is an `ask` or a
 *    `handoff` the room can read. A member that could spawn subagents would
 *    route around the shared stream, and the stream is the record.
 *  - `send_message` / `list_agents` DENY. A room is sealed: coordination
 *    happens in the stream, not through the cross-process peer broker.
 *
 * COMPOSITION IS "STRICTER WINS", NOT "SEAL LAST".
 *
 * Appending the seal wholesale would be wrong in one direction: a seal rule
 * that is merely `ask` would REOPEN a door a definition had already denied,
 * because `Permission.evaluate` is findLast and the last rule wins. So `extra`
 * evaluates the effective ruleset at each seal rule's own coordinates and emits
 * that rule ONLY when it is stricter than the answer already there.
 *
 * The result is appended to the SESSION ruleset, which session/tools.ts merges
 * AFTER the agent's own (`Permission.merge(agent.permission, live.permission)`),
 * so a seal rule that is emitted always wins.
 */

/** deny beats ask beats allow. The whole ordering the composition turns on. */
const RANK: Record<PermissionV1.Action, number> = { allow: 0, ask: 1, deny: 2 }

const deny = (permission: string): PermissionV1.Rule => ({ permission, pattern: "*", action: "deny" })

/**
 * What a room closes regardless of the definition.
 *
 * Deliberately SHORT. It is not a sandbox and never was — `edit` and `bash` are
 * absent because whether a member may build is the definition's call (the
 * worker/observer split), not the room's.
 */
export const ROOM_SEAL: readonly PermissionV1.Rule[] = [
  deny("task"),
  deny("todowrite"),
  deny("send_message"),
  deny("list_agents"),
]

/**
 * WHAT A COUNCIL ROUND CLOSES, on top of the room.
 *
 * A council dispatches its opinions SIDE BY SIDE, and two agents writing the
 * same file at the same time is a corruption rather than a race a room can
 * referee (`CollabParallel`'s header sets out why worktree isolation cannot be
 * composed into a room). Until now that hazard was answered by REFUSING the
 * setting: `collab_set_flavor` would not turn a room into a council unless every
 * member was already read-only for files, and a person whose whole ask was
 * "these three bots, this question" got a paragraph about permission rulesets
 * instead of a council.
 *
 * The hazard is answered HERE instead, where it actually happens. A round turn
 * runs with every file-writing door shut, so a room of WORKERS becomes a council
 * with nothing to configure — and the same member keeps `edit` and `bash` in the
 * DISCUSS turns of the same room, because a discuss room is serial and has never
 * had this hazard.
 *
 * ROOM_SEAL rides along so a round turn can never end up LESS sealed than the
 * room it is in, and composition is `extra`'s: stricter wins, per tool.
 *
 * Reading is untouched on purpose. A council deliberates OVER the workspace, and
 * an opinion formed without reading the code is the failure this whole mode
 * exists to avoid.
 */
export const COUNCIL_SEAL: readonly PermissionV1.Rule[] = [
  ...ROOM_SEAL,
  ...CollabParallel.FILE_WRITE_PERMISSIONS.map(deny),
]

/**
 * The rules to APPEND so `base` is at least as strict as `seal`, everywhere the
 * seal has an opinion. Returns only what changes something, so a ruleset that
 * is already sealed grows by nothing and the composition is idempotent.
 */
export function extra(base: PermissionV1.Ruleset, seal: readonly PermissionV1.Rule[]): PermissionV1.Rule[] {
  const out: PermissionV1.Rule[] = []
  for (const rule of seal) {
    const current = Permission.evaluate(rule.permission, rule.pattern, base, out)
    if (RANK[rule.action] > RANK[current.action]) out.push(rule)
  }
  return out
}

/**
 * The session ruleset a collab child session runs under: what the caller
 * derived, plus whatever the seal has to tighten once the definition's own
 * rules are taken into account.
 */
export function sessionPermission(input: {
  agentPermission: PermissionV1.Ruleset
  sessionPermission: PermissionV1.Ruleset
  seal?: readonly PermissionV1.Rule[]
}): PermissionV1.Rule[] {
  const effective = Permission.merge(input.agentPermission, input.sessionPermission)
  return [...input.sessionPermission, ...extra(effective, input.seal ?? ROOM_SEAL)]
}

export * as CollabSeal from "./seal"
