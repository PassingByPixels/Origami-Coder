import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@origami/core/v1/permission"
import { AgentBot } from "../../src/agent/bot"
import { Permission } from "../../src/permission"

/**
 * THE BOT CONTRACT, read off a definition's frontmatter.
 *
 * Every field is optional and every default is today's behaviour: a definition
 * that carries none of these keys must produce an EMPTY ruleset, because the
 * engine's own defaults are what a def has always run under. A test that only
 * proved the tiers work would let an empty contract quietly restrict every
 * existing definition on disk.
 */

const act = (ruleset: PermissionV1.Ruleset, permission: string, pattern = "*") =>
  Permission.evaluate(permission, pattern, ruleset).action

/** The frontmatter as the loader hands it over: unknown keys swept into `options`. */
const options = (input: Record<string, unknown>) => input

describe("AgentBot.read — the vocabulary", () => {
  test("a definition with no bot keys asks for nothing", () => {
    const contract = AgentBot.read(options({}))
    expect(contract.tier).toBeUndefined()
    expect(contract.skills).toBeUndefined()
    expect(contract.memory).toBe(true)
    expect(AgentBot.ruleset(contract)).toEqual([])
  })

  test("`model_prefer:` is GONE, and a definition still carrying it reads clean", () => {
    // The owner's ruling: a bot has a pinned model, or it has none and says so.
    // The preference was a second answer to "which model" that only ever fired
    // when the first was absent, and a def written against the old build is
    // still on somebody's disk - it must parse, and the key must do nothing.
    const contract = AgentBot.read(
      options({ permissions: "standard", model_prefer: ["local+large-context", "any"], memory: false }),
    )
    expect(contract).toEqual({ tier: "standard", memory: false })
    expect("modelPrefer" in contract).toBe(false)
    // The rest of the contract is unaffected by the stale key beside it.
    expect(AgentBot.ruleset(contract).length).toBeGreaterThan(0)
  })

  test("`memory: false` opts a bot out of its own store", () => {
    expect(AgentBot.read(options({ memory: false })).memory).toBe(false)
  })

  test("an unrecognised tier adds NO rules and is reported, never guessed", () => {
    const contract = AgentBot.read(options({ permissions: "stritc" }))
    expect(contract.tier).toBeUndefined()
    expect(contract.unknownTier).toBe("stritc")
    expect(AgentBot.ruleset(contract)).toEqual([])
  })
})

describe("AgentBot.ruleset — permission tiers map onto the existing vocabulary", () => {
  const rulesetFor = (tier: string) => AgentBot.ruleset(AgentBot.read(options({ permissions: tier })))

  test("strict is read-only: the observer preset, by another name", () => {
    const rules = rulesetFor("strict")
    expect(act(rules, "read")).toBe("allow")
    expect(act(rules, "grep")).toBe("allow")
    expect(act(rules, "glob")).toBe("allow")
    expect(act(rules, "list")).toBe("allow")
    expect(act(rules, "edit")).toBe("deny")
    expect(act(rules, "bash")).toBe("deny")
    expect(act(rules, "task")).toBe("deny")
    expect(act(rules, "todowrite")).toBe("deny")
    // deny-by-default: anything not re-granted is closed
    expect(act(rules, "webfetch")).toBe("deny")
  })

  test("both tiers keep `skill` open, or the skills allowlist could never widen", () => {
    expect(act(rulesetFor("strict"), "skill", "alpha")).toBe("allow")
    expect(act(rulesetFor("standard"), "skill", "alpha")).toBe("allow")
  })

  test("standard can build: the worker preset, by another name", () => {
    const rules = rulesetFor("standard")
    expect(act(rules, "read")).toBe("allow")
    expect(act(rules, "edit")).toBe("allow")
    expect(act(rules, "bash")).toBe("allow")
    // delegation still leaves the room's record — unchanged from collabPresets
    expect(act(rules, "task")).toBe("deny")
    expect(act(rules, "todowrite")).toBe("deny")
  })

  test("open adds nothing at all, so the engine defaults stand", () => {
    expect(rulesetFor("open")).toEqual([])
  })
})

describe("AgentBot.ruleset — the skills allowlist rides the skill permission", () => {
  test("a list denies every skill and re-grants the named ones", () => {
    const rules = AgentBot.ruleset(AgentBot.read(options({ skills: ["alpha", "beta"] })))
    expect(act(rules, "skill", "alpha")).toBe("allow")
    expect(act(rules, "skill", "beta")).toBe("allow")
    expect(act(rules, "skill", "gamma")).toBe("deny")
  })

  test("an EMPTY list means no skills, not all skills", () => {
    const rules = AgentBot.ruleset(AgentBot.read(options({ skills: [] })))
    expect(act(rules, "skill", "alpha")).toBe("deny")
  })

  test("`skills: false` is the same closed door as an empty list", () => {
    const rules = AgentBot.ruleset(AgentBot.read(options({ skills: false })))
    expect(act(rules, "skill", "alpha")).toBe("deny")
  })

  test("an ABSENT skills key closes no skill, with or without a tier", () => {
    const tiered = AgentBot.ruleset(AgentBot.read(options({ permissions: "standard" })))
    expect(act(tiered, "skill", "anything")).toBe("allow")
    // With no tier either, the contract writes no skill rule at all, so the
    // engine's own default is what answers.
    const bare = AgentBot.ruleset(AgentBot.read(options({ memory: true })))
    expect(bare.some((rule) => rule.permission === "skill")).toBe(false)
  })

  test("non-string entries are dropped rather than written as a pattern", () => {
    const contract = AgentBot.read(options({ skills: ["alpha", 7, null] }))
    expect(contract.skills).toEqual(["alpha"])
  })
})

describe("AgentBot.TEMPLATE — the scaffold a shell writes for a new bot", () => {
  test("documents every field this build reads, so the template cannot drift from the reader", () => {
    for (const key of ["permissions", "skills", "memory"]) {
      expect(AgentBot.TEMPLATE).toContain(key)
    }
    // Both tiers a picker would offer.
    for (const tier of ["strict", "standard", "open"]) expect(AgentBot.TEMPLATE).toContain(tier)
  })

  test("does not teach a key this build ignores", () => {
    // A scaffold that still offered `model_prefer:` would hand every new bot a
    // line that silently does nothing.
    expect(AgentBot.TEMPLATE).not.toContain("model_prefer")
  })

  test("is a real definition: frontmatter fences and a persona below them", () => {
    const lines = AgentBot.TEMPLATE.split("\n")
    expect(lines[0]).toBe("---")
    expect(lines.indexOf("---", 1)).toBeGreaterThan(1)
  })
})

describe("AgentBot.ruleset — order inside the contract", () => {
  test("the skills gate survives a deny-by-default tier", () => {
    // "*": deny from the tier lands FIRST, so the skill allow that follows it
    // still resolves — the whole point of composing them in one ruleset.
    const rules = AgentBot.ruleset(AgentBot.read(options({ permissions: "strict", skills: ["alpha"] })))
    expect(act(rules, "skill", "alpha")).toBe("allow")
    expect(act(rules, "skill", "gamma")).toBe("deny")
    expect(act(rules, "edit")).toBe("deny")
  })
})

/**
 * WHICH DEFINITIONS COMPOSE. `isBot` decides how a turn's system prompt is
 * built (base prompt + persona, and no workspace instruction files), so a false
 * positive silently changes an ordinary agent's prompt and a false negative
 * leaves a bot with the old substitution. The three facts are read off the file
 * shape the Bots pane writes, which is why each one is pinned alone here.
 */
describe("AgentBot.isBot - which definitions are characters", () => {
  const def = (input: Record<string, unknown>) =>
    ({ options: {}, ...input }) as { native?: boolean; hidden?: boolean; options: Record<string, unknown> }

  test("the shape the Bots pane writes IS a bot", () => {
    expect(AgentBot.isBot(def({ native: false, hidden: true, options: { collab: true } }))).toBe(true)
    // `native` absent is the same claim as `native: false` - a definition loaded
    // from a file never sets it true.
    expect(AgentBot.isBot(def({ hidden: true, options: { collab: true } }))).toBe(true)
  })

  test('a YAML-quoted `collab: "true"` counts, exactly as it does for collabCapable', () => {
    expect(AgentBot.isBot(def({ hidden: true, options: { collab: "true" } }))).toBe(true)
  })

  test("an ENGINE agent is never a character, however it is flagged", () => {
    // compaction/title/summary are hidden AND native. Composing on top of the
    // base prompt would put default.txt into a prompt built to be alone.
    expect(AgentBot.isBot(def({ native: true, hidden: true, options: { collab: true } }))).toBe(false)
  })

  test("a VISIBLE definition is a chat mode, not a roster member", () => {
    expect(AgentBot.isBot(def({ options: { collab: true } }))).toBe(false)
  })

  test("a hidden def that never opted into rooms is not a bot - `vision-profile:` is written INSTEAD of `collab:`", () => {
    expect(AgentBot.isBot(def({ hidden: true, options: { "vision-profile": true } }))).toBe(false)
    expect(AgentBot.isBot(def({ hidden: true, options: { collab: false } }))).toBe(false)
    expect(AgentBot.isBot(def({ hidden: true, options: {} }))).toBe(false)
  })
})
