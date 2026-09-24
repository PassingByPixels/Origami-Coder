import { PermissionV1 } from "@origami/core/v1/permission"
import { Permission } from "@/permission"
import { CollabParallel } from "./parallel"

/**
 * THE SEALS A ROOM APPLIES OVER A DEFINITION'S OWN PERMISSIONS.
 *
 * {@link ROOM_SEAL} applies at child-session CREATE, for as long as the member
 * is in the room; {@link COUNCIL_SEAL} for the length of ONE council round turn.
 *
 * The room seal is the engine's copy of the room's invariants, applied whatever
 * the definition says: `task` and `todowrite` DENY, so delegation inside a room
 * is an `ask` or a `handoff` the shared stream can record; `send_message` and
 * `list_agents` DENY, so coordination happens in the stream and not through the
 * cross-process peer broker.
 *
 * COMPOSITION IS "STRICTER WINS", NOT "SEAL LAST". `Permission.evaluate` is
 * findLast, so appending a seal rule that is merely `ask` would REOPEN a door a
 * definition had denied; `extra` emits a seal rule only where it is stricter
 * than the answer already there. The result is appended to the SESSION ruleset,
 * which session/tools.ts merges AFTER the agent's own, so it always wins.
 */

/** deny beats ask beats allow. The whole ordering the composition turns on. */
const RANK: Record<PermissionV1.Action, number> = { allow: 0, ask: 1, deny: 2 }

const deny = (permission: string): PermissionV1.Rule => ({ permission, pattern: "*", action: "deny" })

/**
 * What a room closes regardless of the definition. Deliberately SHORT: it is
 * not a sandbox - `edit` and `bash` are absent because whether a member may
 * build is the definition's call (the worker/observer split), not the room's.
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
 * same file at once is corruption rather than a race a room can referee. The
 * hazard is answered HERE, where it happens: a round turn runs with every
 * file-writing door shut, so a room of WORKERS becomes a council with nothing
 * to configure, and the same member keeps `edit` and `bash` in the serial
 * DISCUSS turns of the same room. ROOM_SEAL rides along so a round turn can
 * never be LESS sealed than its room. Reading is untouched on purpose: an
 * opinion formed without reading the code is the failure this mode avoids.
 */
export const COUNCIL_SEAL: readonly PermissionV1.Rule[] = [
  ...ROOM_SEAL,
  ...CollabParallel.FILE_WRITE_PERMISSIONS.map(deny),
]

/** The rules to APPEND so `base` is at least as strict as `seal`, everywhere the
 *  seal has an opinion. Returns only what changes something, so a ruleset that
 *  is already sealed grows by nothing and the composition is idempotent. */
export function extra(base: PermissionV1.Ruleset, seal: readonly PermissionV1.Rule[]): PermissionV1.Rule[] {
  const out: PermissionV1.Rule[] = []
  for (const rule of seal) {
    const current = Permission.evaluate(rule.permission, rule.pattern, base, out)
    if (RANK[rule.action] > RANK[current.action]) out.push(rule)
  }
  return out
}

/** The session ruleset a collab child session runs under: what the caller
 *  derived, plus whatever the seal has to tighten once the definition's own
 *  rules are taken into account. */
export function sessionPermission(input: {
  agentPermission: PermissionV1.Ruleset
  sessionPermission: PermissionV1.Ruleset
  seal?: readonly PermissionV1.Rule[]
}): PermissionV1.Rule[] {
  const effective = Permission.merge(input.agentPermission, input.sessionPermission)
  return [...input.sessionPermission, ...extra(effective, input.seal ?? ROOM_SEAL)]
}

export * as CollabSeal from "./seal"
