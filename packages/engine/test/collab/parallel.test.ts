import { describe, expect, it } from "bun:test"
import { PermissionV1 } from "@origami/core/v1/permission"
import { AgentBot } from "@/agent/bot"
import { CollabParallel } from "@/collab/parallel"
import { CollabSeal } from "@/collab/seal"

/**
 * The PARALLEL GATE, as a pure leaf.
 *
 * Every rule here is decided off a ruleset alone, with no store, no runner and
 * no session - which is the point. The gate is the whole write-safety answer
 * for a parallel room (see the DECISION block in src/collab/parallel.ts), so it
 * has to be provable without standing a room up.
 */

const tiered = (tier: AgentBot.PermissionTier): PermissionV1.Ruleset => AgentBot.ruleset({ tier, memory: true })

/** What a collab child session actually runs under: the tier plus the seal. */
const effective = (agentPermission: PermissionV1.Ruleset): PermissionV1.Ruleset => [
  ...agentPermission,
  ...CollabSeal.sessionPermission({ agentPermission, sessionPermission: [] }),
]

describe("dispatchWidth", () => {
  it("reads an unset room as SERIAL - the default is one turn at a time", () => {
    expect(CollabParallel.dispatchWidth(null)).toBe(1)
    expect(CollabParallel.dispatchWidth(undefined)).toBe(1)
    expect(CollabParallel.dispatchWidth(1)).toBe(1)
  })

  it("treats 0 and a negative as SERIAL rather than as 'no limit'", () => {
    // The hop cap spells 0 as OFF. Repeating that spelling here would mean a
    // room with no ceiling on how many turns run at once, which is the one
    // answer this setting must never be able to say by accident.
    expect(CollabParallel.dispatchWidth(0)).toBe(1)
    expect(CollabParallel.dispatchWidth(-3)).toBe(1)
  })

  it("clamps to the ceiling rather than refusing a number above it", () => {
    expect(CollabParallel.dispatchWidth(2)).toBe(2)
    expect(CollabParallel.dispatchWidth(CollabParallel.CONCURRENCY_MAX)).toBe(CollabParallel.CONCURRENCY_MAX)
    expect(CollabParallel.dispatchWidth(CollabParallel.CONCURRENCY_MAX + 5)).toBe(CollabParallel.CONCURRENCY_MAX)
  })

  it("reads a non-integer as SERIAL - a width of 2.7 is not a width", () => {
    expect(CollabParallel.dispatchWidth(2.7)).toBe(1)
    expect(CollabParallel.dispatchWidth(Number.NaN)).toBe(1)
  })
})

describe("visibleAtDispatch", () => {
  const log = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]

  it("hands a SERIAL turn the whole log - it cannot race anything", () => {
    expect(CollabParallel.visibleAtDispatch(log, undefined)).toBe(log)
  })

  it("cuts a parallel turn's read at its dispatch mark", () => {
    // Everything above the mark was written by a turn running BESIDE this one.
    // It is not lost - it is above this agent's last-seen and rides its next
    // batch - which is exactly what the rule promises.
    expect(CollabParallel.visibleAtDispatch(log, 2)).toEqual([{ seq: 1 }, { seq: 2 }])
  })

  it("keeps the message AT the mark - it is what woke the turn", () => {
    expect(CollabParallel.visibleAtDispatch(log, 4)).toEqual(log)
    expect(CollabParallel.visibleAtDispatch(log, 1)).toEqual([{ seq: 1 }])
  })
})

describe("writeGrants", () => {
  it("clears the STRICT tier: every file-writing door is shut at wildcard scope", () => {
    expect(CollabParallel.writeGrants(effective(tiered("strict")))).toEqual([])
  })

  it("names edit and bash on the STANDARD tier - the worker block writes files", () => {
    const grants = CollabParallel.writeGrants(effective(tiered("standard")))
    expect(grants).toContain("edit")
    expect(grants).toContain("bash")
  })

  it("refuses an UNCONSTRAINED definition: silence is not a denial", () => {
    // `open` expands to nothing, which is what a definition with no permission
    // block has always been. Nothing said is not the same as "cannot write",
    // and reading it as read-only would make the gate a decoration.
    const grants = CollabParallel.writeGrants(effective(tiered("open")))
    expect(grants).toEqual([...CollabParallel.FILE_WRITE_PERMISSIONS])
  })

  it("does not accept a NARROW deny as a blanket one", () => {
    // deny edit under src/** says nothing about the rest of the tree.
    const ruleset: PermissionV1.Ruleset = [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "src/**", action: "deny" },
    ]
    expect(CollabParallel.writeGrants(ruleset)).toContain("edit")
  })

  it("catches a re-grant that lands AFTER the deny-all", () => {
    // findLast is how the engine resolves a rule, so the gate has to read the
    // ruleset the same way round: a later allow wins, and the gate must say so.
    const ruleset: PermissionV1.Ruleset = [...tiered("strict"), { permission: "bash", pattern: "*", action: "allow" }]
    expect(CollabParallel.writeGrants(ruleset)).toEqual(["bash"])
  })

  it("treats ASK as a grant - a room with nobody watching cannot answer it", () => {
    const ruleset: PermissionV1.Ruleset = [...tiered("strict"), { permission: "edit", pattern: "*", action: "ask" }]
    expect(CollabParallel.writeGrants(ruleset)).toEqual(["edit"])
  })
})

describe("concurrencyRefusal", () => {
  it("says nothing when every member is read-only for files", () => {
    expect(
      CollabParallel.concurrencyRefusal([
        { agentSlug: "scribe", permission: effective(tiered("strict")) },
        { agentSlug: "reader", permission: effective(tiered("strict")) },
      ]),
    ).toBeUndefined()
  })

  it("names the MEMBER and the permission it holds, not just 'refused'", () => {
    const refusal = CollabParallel.concurrencyRefusal([
      { agentSlug: "scribe", permission: effective(tiered("strict")) },
      { agentSlug: "builder", permission: effective(tiered("standard")) },
    ])
    expect(refusal).toBeString()
    expect(refusal).toContain("builder")
    expect(refusal).toContain("edit")
    expect(refusal).toContain("bash")
    // The member who is already fine is not blamed for the one who is not.
    expect(refusal).not.toContain("scribe")
  })

  it("refuses an EMPTY roster - a room with no members cannot be proven safe", () => {
    expect(CollabParallel.concurrencyRefusal([])).toBeString()
  })
})
