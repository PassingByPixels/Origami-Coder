import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@origami/core/v1/permission"
import { CollabSeal } from "../../src/collab/seal"
import { Permission } from "../../src/permission"

/**
 * THE ROOM SEAL.
 *
 * A bot definition carries its own permissions and can be invited into a room.
 * The room has invariants of its own — delegation must stay inside the shared
 * stream, and a sealed room cannot reach a chat outside it. Neither ruleset may
 * simply overwrite the other: the STRICTER answer wins, per tool.
 *
 * The composition is not "append the seal": appending it would let a seal `ask`
 * REOPEN a door the definition had already denied.
 */

const act = (ruleset: PermissionV1.Ruleset, permission: string, pattern = "*") =>
  Permission.evaluate(permission, pattern, ruleset).action

const rule = (permission: string, action: PermissionV1.Action, pattern = "*"): PermissionV1.Rule => ({
  permission,
  pattern,
  action,
})

/** The effective ruleset a turn evaluates: agent rules first, session rules last. */
const effective = (base: PermissionV1.Ruleset, extra: PermissionV1.Ruleset) => [...base, ...extra]

describe("CollabSeal.ROOM_SEAL", () => {
  test("closes the doors a room cannot see through", () => {
    expect(act(CollabSeal.ROOM_SEAL, "task")).toBe("deny")
    expect(act(CollabSeal.ROOM_SEAL, "todowrite")).toBe("deny")
    expect(act(CollabSeal.ROOM_SEAL, "send_message")).toBe("deny")
  })

  test("says nothing about the tools a room has no opinion on", () => {
    expect(CollabSeal.ROOM_SEAL.some((item) => item.permission === "edit")).toBe(false)
    expect(CollabSeal.ROOM_SEAL.some((item) => item.permission === "bash")).toBe(false)
  })
})

describe("CollabSeal.COUNCIL_SEAL — what a ROUND TURN closes on top of the room", () => {
  test("closes every door that can put bytes on disk, at wildcard scope", () => {
    // Wildcard is the bar `Permission.disabled` reads: a tool is taken out of
    // the model's request only when the LAST matching rule denies at `*`. A
    // narrower deny would leave `edit` in the tool list and gate it at call
    // time, which in a room with no human at the keyboard is not a denial.
    for (const permission of ["edit", "bash", "process", "file_delete", "file_mkdir", "file_copy", "file_move"]) {
      expect(act(CollabSeal.COUNCIL_SEAL, permission)).toBe("deny")
      const last = CollabSeal.COUNCIL_SEAL.findLast((item) => item.permission === permission)
      expect(last?.pattern).toBe("*")
    }
  })

  test("carries the room seal with it, so a round turn is never LESS sealed than the room", () => {
    expect(act(CollabSeal.COUNCIL_SEAL, "task")).toBe("deny")
    expect(act(CollabSeal.COUNCIL_SEAL, "send_message")).toBe("deny")
  })

  test("leaves reading alone - a council deliberates over the workspace", () => {
    expect(CollabSeal.COUNCIL_SEAL.some((item) => item.permission === "read")).toBe(false)
    expect(CollabSeal.COUNCIL_SEAL.some((item) => item.permission === "grep")).toBe(false)
  })

  test("seals a WORKER's session for the round and takes nothing else from it", () => {
    // The whole ruling in one assertion: a `standard` bot keeps `edit` and
    // `bash` in its definition, and a council round turn simply cannot use them.
    const agentPermission = [rule("*", "deny"), rule("read", "allow"), rule("edit", "allow"), rule("bash", "allow")]
    const sessionPermission = CollabSeal.sessionPermission({ agentPermission, sessionPermission: [] })
    const round = CollabSeal.sessionPermission({
      agentPermission,
      sessionPermission,
      seal: CollabSeal.COUNCIL_SEAL,
    })

    expect(act(effective(agentPermission, round), "edit")).toBe("deny")
    expect(act(effective(agentPermission, round), "bash")).toBe("deny")
    expect(act(effective(agentPermission, round), "read")).toBe("allow")
    // …and the DISCUSS ruleset it goes back to is untouched.
    expect(act(effective(agentPermission, sessionPermission), "edit")).toBe("allow")
    expect(act(effective(agentPermission, sessionPermission), "bash")).toBe("allow")
  })
})

describe("CollabSeal.extra — the stricter of the two wins, per tool", () => {
  test("a permissive definition is CLOSED by the seal", () => {
    const base = [rule("*", "allow"), rule("task", "allow")]
    const sealed = effective(base, CollabSeal.extra(base, CollabSeal.ROOM_SEAL))
    expect(act(sealed, "task")).toBe("deny")
  })

  test("a tool the seal never mentions keeps the definition's own answer", () => {
    const base = [rule("*", "deny"), rule("edit", "allow"), rule("bash", "allow")]
    const sealed = effective(base, CollabSeal.extra(base, CollabSeal.ROOM_SEAL))
    expect(act(sealed, "edit")).toBe("allow")
    expect(act(sealed, "bash")).toBe("allow")
  })

  test("a DEFINITION deny survives a softer seal — the seal never reopens a door", () => {
    const base = [rule("edit", "deny")]
    const soft = [rule("edit", "ask")]
    const sealed = effective(base, CollabSeal.extra(base, soft))
    expect(act(sealed, "edit")).toBe("deny")
  })

  test("a seal `ask` DOES tighten a definition that said allow", () => {
    const base = [rule("edit", "allow")]
    const soft = [rule("edit", "ask")]
    const sealed = effective(base, CollabSeal.extra(base, soft))
    expect(act(sealed, "edit")).toBe("ask")
  })

  test("an already-denying definition needs no extra rules at all", () => {
    const base = [rule("*", "deny")]
    expect(CollabSeal.extra(base, CollabSeal.ROOM_SEAL)).toEqual([])
  })

  test("composition is idempotent — sealing a sealed ruleset adds nothing", () => {
    const base = [rule("*", "allow")]
    const once = effective(base, CollabSeal.extra(base, CollabSeal.ROOM_SEAL))
    expect(CollabSeal.extra(once, CollabSeal.ROOM_SEAL)).toEqual([])
  })
})
