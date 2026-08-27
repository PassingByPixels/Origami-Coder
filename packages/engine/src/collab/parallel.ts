import { PermissionV1 } from "@origami/core/v1/permission"
import { Wildcard } from "@origami/core/util/wildcard"

/**
 * PARALLEL PARTICIPANTS — the room's dispatch width, and the one safety rule
 * that lets it be raised.
 *
 * A collab has always run ONE turn at a time (see the header of runner.ts). The
 * serialization is what makes each turn's envelope carry the previous speaker's
 * fresh reply. A room may now opt OUT of that with `concurrency: N`, and this
 * leaf owns both halves of what opting out costs.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE WRITE-SAFETY DECISION: GATE, NOT WORKTREES.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Two agents writing the same file at the same time is a corruption, not a
 * race the room can referee. The obvious answer is the one the agent manager
 * already ships: give each parallel worker its own git worktree
 * (packages/vscode/src/dashboard/agentManager/fanout.ts + worktrees.ts, which
 * run 2-4 agents concurrently, each on its own branch, race-free because
 * `createWorktree` serializes per repo).
 *
 * That machinery CANNOT be composed in here, and saying otherwise would be the
 * dishonest version of this feature:
 *
 *  - It lives extension-side and is built on the agent manager's `RunContext`,
 *    its worktree records and its board broadcast. None of that exists in the
 *    engine, and none of it is a library.
 *  - A collab child session has no cwd of its own. Every member of a room runs
 *    under the ONE `InstanceRef` the room was bound to (runner.ts `inCollab`).
 *    Per-worker isolation means a per-participant working directory, a branch
 *    per worker, and a merge-back with a human verdict on the result — a
 *    product, not a parameter.
 *
 * So an EXPLICIT concurrency raise gates instead. A room may raise its width
 * only when every member's EFFECTIVE permission — post-tier, post-definition,
 * post-room-seal — denies every file-writing door outright. A wide discuss room
 * deliberates, reads and reports; it does not build. Worktree-isolated parallel
 * WORKERS stay a named, separate arc, and the refusal below says so in words a
 * human can act on rather than failing silently at write time.
 *
 * THE `council` FLAVOR IS NOT GATED HERE, and used to be. A council also
 * dispatches wide, but its turns are not the room's ordinary turns: a round is
 * opinions and a synthesis, and nothing in a round is meant to build. So it
 * takes the OTHER answer to the same hazard — the round turns are sealed
 * read-only (`CollabSeal.COUNCIL_SEAL`) and the setting is simply allowed. What
 * is left below is the gate for the case where the two cannot be separated: a
 * human asking for their ordinary turns, the ones that DO build, to run at once.
 *
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * The most turns one room may dispatch at once.
 *
 * 4, mirroring the agent manager's own race width. Above that a room stops
 * being watchable: the stream interleaves faster than a human reads it, and
 * the whole point of waves 1-4 was that a running room can be followed.
 */
export const CONCURRENCY_MAX = 4

/**
 * The dispatch width a stored setting means.
 *
 * ANYTHING that is not a whole number of 2 or more reads as SERIAL, including
 * 0. That is a deliberate difference from the hop cap, where 0 spells OFF: an
 * "off" concurrency would be a room with no ceiling on parallel turns, which is
 * the one thing this setting must never say by accident. Above the ceiling
 * clamps rather than refuses, so an older shell writing a larger number gets
 * the safest reading of it instead of an error.
 */
export function dispatchWidth(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 1) return 1
  return Math.min(value, CONCURRENCY_MAX)
}

/**
 * THE VISIBILITY RULE, as the one line that enforces it.
 *
 * A turn reads the room as it stood when it was DISPATCHED. `ceiling` is the
 * newest seq the room had at that instant; everything above it was written by a
 * turn running BESIDE this one and belongs to this agent's next batch, not this
 * envelope.
 *
 * A serial room passes no ceiling and reads the whole log. It cannot need one:
 * its drain joins each turn before starting the next, so nothing can be written
 * between a dispatch and its read.
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
 * `edit` covers write/edit/patch — this engine has no `write` permission (see
 * AgentBot's tier table). `bash` and `process` are here because a shell is a
 * file-writing tool with extra steps, and a gate that let them through would
 * be checking the front door while the window is open.
 *
 * ONE LIST, TWO READERS. The concurrency gate below asks which of these a member
 * still holds; `CollabSeal.COUNCIL_SEAL` denies all of them for the length of a
 * council round turn. A second copy of this list would let the question and the
 * answer drift apart.
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
 * Read the way the engine itself resolves a rule — `Permission.evaluate` is
 * findLast — so a re-grant after a deny-all is caught rather than hidden by it.
 *
 * The bar is a BLANKET deny: the last matching rule must deny at `*`. Two
 * things fail that on purpose:
 *
 *  - A narrow deny (`edit` under `src/**`) says nothing about the rest of the
 *    tree, so it is not a denial of `edit`.
 *  - `ask` is a grant here. The engine's own default for an unmatched rule is
 *    `ask`, and a room turn has no human at the keyboard to answer one: an ask
 *    is a write that happens as soon as somebody clicks yes.
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
 * Names the member AND the doors it holds open. "Refused" on its own is not
 * actionable: the fix is a `permissions: strict` line in one definition, and a
 * human cannot find which file to put it in from a bare no.
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
