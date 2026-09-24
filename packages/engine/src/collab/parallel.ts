import { PermissionV1 } from "@origami/core/v1/permission"
import { Wildcard } from "@origami/core/util/wildcard"

/**
 * PARALLEL PARTICIPANTS - the room's dispatch width, and the safety rule that
 * lets it be raised.
 *
 * A collab runs ONE turn at a time, which is what makes each turn's envelope
 * carry the previous speaker's fresh reply. A room may opt out of that with
 * `concurrency: N`, and this leaf owns what opting out costs.
 *
 * Two agents writing the same file at once is corruption, not a race the room
 * can referee, and per-worker git worktrees cannot be composed in here: that
 * machinery is extension-side, and a collab child session has no cwd of its own
 * (every member runs under the ONE `InstanceRef` the room was bound to). So a
 * width raise is GATED: allowed only when every member's EFFECTIVE permission
 * denies every file-writing door outright. The `council` flavor is not gated
 * here - its round turns are sealed read-only (`CollabSeal.COUNCIL_SEAL`).
 */

/**
 * The most turns one room may dispatch at once. 4, mirroring the agent
 * manager's own race width; above that the stream interleaves faster than a
 * human can follow the room.
 */
export const CONCURRENCY_MAX = 4

/**
 * The dispatch width a stored setting means.
 *
 * ANYTHING that is not a whole number of 2 or more reads as SERIAL, including
 * 0 - unlike the hop cap, where 0 spells OFF; an "off" concurrency would be a
 * room with no ceiling on parallel turns. Above the ceiling clamps, so an older
 * shell writing a larger number gets the safest reading rather than an error.
 */
export function dispatchWidth(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 1) return 1
  return Math.min(value, CONCURRENCY_MAX)
}

/**
 * THE VISIBILITY RULE, as the one line that enforces it.
 *
 * A turn reads the room as it stood when it was DISPATCHED. `ceiling` is the
 * newest seq at that instant; anything above it was written by a turn running
 * BESIDE this one. A serial room passes no ceiling and reads the whole log: its
 * drain joins each turn before starting the next.
 */
export function visibleAtDispatch<M extends { readonly seq: number }>(
  messages: readonly M[],
  ceiling: number | undefined,
): readonly M[] {
  if (ceiling === undefined) return messages
  return messages.filter((message) => message.seq <= ceiling)
}

/**
 * Every permission that can put bytes on disk.
 *
 * `edit` covers write/edit/patch; `bash` and `process` are here because a shell
 * is a file-writing tool with extra steps. ONE LIST, TWO READERS: the
 * concurrency gate asks which of these a member still holds, and
 * `CollabSeal.COUNCIL_SEAL` denies all of them for a council round turn.
 */
export const FILE_WRITE_PERMISSIONS: readonly string[] = [
  "edit",
  "bash",
  "process",
  "file_delete",
  "file_mkdir",
  "file_copy",
  "file_move",
]

/**
 * Which file-writing permissions this ruleset does NOT provably deny.
 *
 * Read the way the engine resolves a rule - `Permission.evaluate` is findLast -
 * so a re-grant after a deny-all is caught rather than hidden by it. The bar is
 * a BLANKET deny: the last matching rule must deny at `*`. A narrow deny
 * (`edit` under one subtree) says nothing about the rest of it, and `ask` is a
 * grant here - a room turn has no human at the keyboard, so an ask is a write
 * that happens as soon as somebody clicks yes.
 */
export function writeGrants(ruleset: PermissionV1.Ruleset): string[] {
  const granted: string[] = []
  for (const permission of FILE_WRITE_PERMISSIONS) {
    const last = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
    if (last?.action === "deny" && last.pattern === "*") continue
    granted.push(permission)
  }
  return granted
}

/** One member, with the ruleset its child session would actually run under. */
export type Member = {
  readonly agentSlug: string
  readonly permission: PermissionV1.Ruleset
}

/**
 * Why this room may NOT raise its concurrency, or undefined when it may.
 *
 * Names the member AND the doors it holds open: the fix is a `permissions:
 * strict` line in one definition, and a bare refusal does not say which file.
 */
export function concurrencyRefusal(members: readonly Member[]): string | undefined {
  if (members.length === 0) {
    return "a room with no members cannot run turns in parallel: invite the agents first"
  }
  const offenders = members
    .map((member) => ({ agentSlug: member.agentSlug, grants: writeGrants(member.permission) }))
    .filter((entry) => entry.grants.length > 0)
  if (offenders.length === 0) return undefined
  const named = offenders.map((entry) => `${entry.agentSlug} (${entry.grants.join(", ")})`).join("; ")
  return (
    `parallel turns need every member to be read-only for files, and these can still write: ${named}. ` +
    `Give them \`permissions: strict\` in their definition, or leave this room at concurrency 1.`
  )
}

export * as CollabParallel from "./parallel"
