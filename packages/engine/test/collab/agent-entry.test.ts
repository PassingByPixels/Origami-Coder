import { describe, expect, test } from "bun:test"
import type { Agent } from "@/agent/agent"
import { ACPCollab } from "@/collab/acp"

/**
 * THE ROSTER ROW ON THE WIRE.
 *
 * The contract fields are ADDITIVE and OMITTED at their defaults, so a shell can
 * tell "the author chose this" from "the author said nothing" - the difference
 * between a selected tier and an empty control. A field carrying its own default
 * would make every definition ever written look configured.
 */

const info = (options: Record<string, unknown> = {}): Agent.Info => ({
  name: "collab-crane",
  description: "Crane",
  mode: "all",
  permission: [],
  options,
})

describe("ACPCollab.agentEntry", () => {
  test("a definition with no contract keeps the row it has always had", () => {
    expect(ACPCollab.agentEntry(info({ collab: true }))).toEqual({
      slug: "collab-crane",
      displayName: "Crane",
      model: null,
    })
  })

  test("a declared tier and allowlist reach the shell", () => {
    const entry = ACPCollab.agentEntry(info({ collab: true, permissions: "strict", skills: ["alpha"] }))
    expect(entry.permissions).toBe("strict")
    expect(entry.skills).toEqual(["alpha"])
  })

  test("a stale `model_prefer:` on disk never reaches the wire", () => {
    // The field is gone from the contract, so the row must not grow it back.
    // A shell reading `modelPrefer` off a roster row would render a control for
    // a setting no build honours.
    const entry = ACPCollab.agentEntry(info({ collab: true, model_prefer: ["local", "any"] }))
    expect(entry).toEqual({ slug: "collab-crane", displayName: "Crane", model: null })
  })

  test("an empty allowlist is carried as an empty array, never as absent", () => {
    // `[]` (no skills) and absent (every skill) are different answers, and a
    // row that collapsed them would render the same control for both.
    expect(ACPCollab.agentEntry(info({ skills: [] })).skills).toEqual([])
    expect(ACPCollab.agentEntry(info({})).skills).toBeUndefined()
  })

  test("memory appears only when a definition opted OUT", () => {
    expect(ACPCollab.agentEntry(info({})).memory).toBeUndefined()
    expect(ACPCollab.agentEntry(info({ memory: false })).memory).toBe(false)
  })

  test("an unrecognised tier is reported so the shell can show the typo", () => {
    const entry = ACPCollab.agentEntry(info({ permissions: "stritc" }))
    expect(entry.permissions).toBeUndefined()
    expect(entry.unknownPermissions).toBe("stritc")
  })
})
