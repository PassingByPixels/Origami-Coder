import { describe, expect, test } from "bun:test"
import { ConfigAgentV1 } from "@origami/core/v1/config/agent"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { FlockConfigV1 } from "@origami/core/v1/config/flock"
import { Cause, Exit, Schema } from "effect"
import { FastCheck } from "effect/testing"

const decodeFlock = (value: unknown) =>
  Schema.decodeUnknownExit(FlockConfigV1.Info)(value, { errors: "all", propertyOrder: "original" })

const decodeConfig = (value: unknown) =>
  Schema.decodeUnknownExit(ConfigV1.Info)(value, { errors: "all", propertyOrder: "original" })

function accepted<A>(exit: Exit.Exit<A, unknown>): A {
  if (Exit.isFailure(exit)) throw new Error(`expected decode to succeed, got: ${String(Cause.squash(exit.cause))}`)
  return exit.value
}

function rejection(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) throw new Error(`expected decode to fail, but it produced ${JSON.stringify(exit.value)}`)
  return String(Cause.squash(exit.cause))
}

// A profile that uses every field the CURRENT schema offers, so a regression in
// any one of them shows up as a decode failure rather than a silently dropped
// value.
const FULL = {
  profile: "local-first",
  profiles: {
    "local-first": {
      description: "local where it can be, cloud where it must be",
      subagents: { use: "spark-vllm/laguna", fallback: ["lmstudio/qwen-32b", "anthropic/claude-fable-5"] },
    },
  },
}

// The pre-E1 shape, verbatim. Every one of these files is out there on someone's
// disk right now; the whole read-compat contract is that they still LOAD.
const OLD = {
  profile: "local-first",
  profiles: {
    "local-first": {
      description: "local where it can be, cloud where it must be",
      executor: { use: "anthropic/claude-fable-5" },
      scout: { use: "spark-vllm/laguna", fallback: ["lmstudio/qwen-32b"], fanout: 16 },
      workhorse: { use: "lmstudio/qwen-32b" },
      roles: {
        vision: { use: "openai/gpt-5.5" },
        compact: { use: "spark-vllm/laguna", escalate: "openai/gpt-5.5" },
      },
    },
  },
}

describe("FlockConfigV1 schema — the subagents shape", () => {
  test("decodes a profile that uses every field", () => {
    const decoded = accepted(decodeFlock(FULL))
    expect(decoded.profile).toBe("local-first")
    const profile = decoded.profiles?.["local-first"]
    expect(profile?.subagents).toEqual({
      use: "spark-vllm/laguna",
      fallback: ["lmstudio/qwen-32b", "anthropic/claude-fable-5"],
    })
    expect(profile?.description).toBe("local where it can be, cloud where it must be")
  })

  test("accepts a profile that binds subagents and nothing else", () => {
    const decoded = accepted(decodeFlock({ profiles: { p: { subagents: { use: "a/b" } } } }))
    expect(decoded.profiles?.["p"]).toEqual({ subagents: { use: "a/b" } })
  })

  test("accepts a profile that binds nothing at all", () => {
    // Not the same as an unknown profile: it exists, it is selectable, and it
    // routes nothing. The router treats it as silence (D10).
    const decoded = accepted(decodeFlock({ profiles: { p: { description: "just a label" } } }))
    expect(decoded.profiles?.["p"]?.subagents).toBeUndefined()
  })

  test("rejects a subagents binding with no use", () => {
    expect(rejection(decodeFlock({ profiles: { p: { subagents: { fallback: ["a/b"] } } } }))).toContain("use")
  })

  test("rejects an unknown top-level profile key even beside valid ones", () => {
    // The Schema.Struct silent-strip trap: a struct that merely ignored an
    // unknown key would decode `{ orchestrator: … }` to a profile that binds
    // NOTHING — routing silently off, config file looking fine. The key filter
    // is what makes a stale or typo'd profile say so.
    const exit = decodeFlock({ profiles: { p: { subagents: { use: "a/b" }, orchestrator: { use: "c/d" } } } })
    expect(rejection(exit)).toContain(`unknown flock profile key "orchestrator"`)
  })

  test("rejects a profile that is an array rather than an object", () => {
    expect(rejection(decodeFlock({ profiles: { p: [] } }))).toContain("object")
  })

  test("treats an absent or null profile as valid input", () => {
    expect(accepted(decodeFlock({})).profile).toBeUndefined()
    expect(accepted(decodeFlock({ profile: null })).profile).toBeNull()
    expect(accepted(decodeFlock({ profile: null, profiles: { p: {} } })).profiles?.["p"]).toBeDefined()
  })

  test("can be sampled by arbitrary generation", () => {
    // `Schema.toArbitrary(ConfigV1.Info)` backs a property test in
    // core/test/config/config.test.ts. The key filters need their `patterns`
    // generation hint or the sampler draws random strings against a small
    // allowlist and never lands one — the whole config property test then hangs
    // rather than fails. If this test stops finishing, that hint is what went
    // missing.
    const roleNames = new Set<string>()
    const profileKeys = new Set<string>()
    FastCheck.assert(
      FastCheck.property(Schema.toArbitrary(FlockConfigV1.Info), (info) => {
        for (const profile of Object.values(info.profiles ?? {})) {
          for (const key of Object.keys(profile)) profileKeys.add(key)
          for (const name of Object.keys(profile.roles ?? {})) roleNames.add(name)
        }
        return true
      }),
      { numRuns: 50 },
    )
    expect(roleNames.size).toBeGreaterThan(0)
    expect([...roleNames].every((name) => (FlockConfigV1.ROLE_NAMES as readonly string[]).includes(name))).toBe(true)
    // Samples stay inside the profile's declared key space. An implementation
    // that guarded the keys with a trailing index signature would generate a
    // random key here — and generate garbage over `description` and `subagents`
    // with it, quietly weakening every property test built on this arbitrary.
    expect(profileKeys.size).toBeGreaterThan(0)
    const known = ["description", "subagents", ...FlockConfigV1.SLOT_NAMES, "roles"]
    expect([...profileKeys].filter((key) => !known.includes(key))).toEqual([])
  })
})

describe("FlockConfigV1 schema — reading the old shape", () => {
  test("decodes a pre-E1 profile whole, fanout and escalate included", () => {
    // Dropping these from the schema would fail the config LOAD of every file
    // that carries one, which is a bricked engine, not a migration.
    const decoded = accepted(decodeFlock(OLD))
    const profile = decoded.profiles?.["local-first"]
    expect(profile?.executor).toEqual({ use: "anthropic/claude-fable-5" })
    expect(profile?.scout).toEqual({ use: "spark-vllm/laguna", fallback: ["lmstudio/qwen-32b"], fanout: 16 })
    expect(profile?.workhorse).toEqual({ use: "lmstudio/qwen-32b" })
    expect(profile?.roles?.["vision"]).toEqual({ use: "openai/gpt-5.5" })
    expect(profile?.roles?.["compact"]?.escalate).toBe("openai/gpt-5.5")
  })

  test("accepts every legacy slot name and every legacy role name", () => {
    const slots = Object.fromEntries(FlockConfigV1.SLOT_NAMES.map((name) => [name, { use: "p/m" }]))
    const roles = Object.fromEntries(FlockConfigV1.ROLE_NAMES.map((name) => [name, { use: "p/m" }]))
    const decoded = accepted(decodeFlock({ profiles: { all: { ...slots, roles } } }))
    expect(Object.keys(decoded.profiles?.["all"]?.roles ?? {}).sort()).toEqual([...FlockConfigV1.ROLE_NAMES].sort())
  })

  test("rejects an unknown role name instead of dropping it", () => {
    // Unchanged from before E1: a silently dropped key means a typo'd role
    // vanishes with no explanation anywhere.
    expect(rejection(decodeFlock({ profiles: { p: { roles: { reed: { use: "a/b" } } } } }))).toContain(
      `unknown flock role "reed"`,
    )
  })

  test("rejects the pre-§7b role-keyed profile shape, which was never valid here either", () => {
    const exit = decodeFlock({ profiles: { p: { judge: { use: "anthropic/claude-2" } } } })
    expect(rejection(exit)).toContain(`unknown flock profile key "judge"`)
  })

  test("rejects a non-positive or fractional legacy fanout", () => {
    expect(rejection(decodeFlock({ profiles: { p: { scout: { use: "a/b", fanout: 0 } } } }))).toContain(
      "greater than 0",
    )
    expect(rejection(decodeFlock({ profiles: { p: { scout: { use: "a/b", fanout: 1.5 } } } }))).toContain("integer")
  })
})

describe("FlockConfigV1.subagentsOf", () => {
  test("takes the explicit subagents binding as written", () => {
    const profile = accepted(decodeFlock(FULL)).profiles!["local-first"]!
    expect(FlockConfigV1.subagentsOf(profile)).toEqual({
      binding: { use: "spark-vllm/laguna", fallback: ["lmstudio/qwen-32b", "anthropic/claude-fable-5"] },
      legacy: false,
    })
  })

  test("maps a legacy executor onto subagents, carrying its fallback and dropping the rest", () => {
    const profile = accepted(decodeFlock(OLD)).profiles!["local-first"]!
    // `fanout` and `escalate` route nothing now, and `scout`/`workhorse`/`roles`
    // are not candidates: `executor` was the trusted slot, so it is the one
    // honest answer to "which model did this user trust with real work".
    expect(FlockConfigV1.subagentsOf(profile)).toEqual({
      binding: { use: "anthropic/claude-fable-5" },
      legacy: true,
    })
  })

  test("carries a legacy executor's fallback chain across", () => {
    const profile = accepted(
      decodeFlock({ profiles: { p: { executor: { use: "a/b", fallback: ["c/d"], fanout: 4 } } } }),
    ).profiles!["p"]!
    expect(FlockConfigV1.subagentsOf(profile)).toEqual({ binding: { use: "a/b", fallback: ["c/d"] }, legacy: true })
  })

  test("prefers an explicit subagents binding over a legacy executor beside it", () => {
    const profile = accepted(
      decodeFlock({ profiles: { p: { subagents: { use: "new/one" }, executor: { use: "old/one" } } } }),
    ).profiles!["p"]!
    expect(FlockConfigV1.subagentsOf(profile)).toEqual({ binding: { use: "new/one" }, legacy: false })
  })

  test("reports the old shape even on a profile that maps to no binding", () => {
    // The pairing that matters: `subagentsOf` answers nothing, so only
    // `hasLegacyShape` can tell the engine there is something to warn about.
    const profile = accepted(decodeFlock({ profiles: { p: { workhorse: { use: "a/b" } } } })).profiles!["p"]!
    expect(FlockConfigV1.subagentsOf(profile)).toBeUndefined()
    expect(FlockConfigV1.hasLegacyShape(profile)).toBe(true)
  })

  test("reports no old shape for a profile written against this version", () => {
    const profile = accepted(decodeFlock(FULL)).profiles!["local-first"]!
    expect(FlockConfigV1.hasLegacyShape(profile)).toBe(false)
  })

  test("answers nothing for a profile with neither", () => {
    const profile = accepted(
      decodeFlock({ profiles: { p: { scout: { use: "a/b" }, roles: { read: { use: "c/d" } } } } }),
    ).profiles!["p"]!
    expect(FlockConfigV1.subagentsOf(profile)).toBeUndefined()
  })
})

describe("ConfigV1.Info flock section", () => {
  test("carries a flock section in the new shape", () => {
    const decoded = accepted(decodeConfig({ flock: FULL }))
    expect(decoded.flock?.profiles?.["local-first"]?.subagents?.use).toBe("spark-vllm/laguna")
  })

  test("carries a flock section in the old shape", () => {
    const decoded = accepted(decodeConfig({ flock: OLD }))
    expect(decoded.flock?.profiles?.["local-first"]?.executor?.use).toBe("anthropic/claude-fable-5")
  })

  test("is inert for a config that does not mention flock", () => {
    const decoded = accepted(decodeConfig({ model: "anthropic/claude-2", small_model: "anthropic/claude-haiku" }))
    expect(decoded.flock).toBeUndefined()
    expect(decoded.model).toBe("anthropic/claude-2")
    expect(decoded.small_model).toBe("anthropic/claude-haiku")
  })

  test("fails the whole config when a profile key is not one this version knows", () => {
    const exit = decodeConfig({ model: "anthropic/claude-2", flock: { profiles: { p: { read: { use: "a/b" } } } } })
    expect(rejection(exit)).toContain(`unknown flock profile key "read"`)
  })
})

describe("agent config `role:` — legacy, accepted and ignored", () => {
  const decodeAgent = (value: unknown) =>
    Schema.decodeUnknownExit(ConfigAgentV1.Info)(value, { errors: "all", propertyOrder: "original" })

  test("still loads an agent file that opted into a role", () => {
    // Nothing routes by role any more, but an agent .md that names one must not
    // fail the load — the user would lose the agent, not just the routing.
    const decoded = accepted(decodeAgent({ mode: "subagent", role: "judge" }))
    expect(decoded.role).toBe("judge")
    // A declared field, not an unknown key: an unknown key is copied into
    // `options` as well, leaving a second, unvalidated copy behind.
    expect(decoded.options).toEqual({})
  })

  test("rejects a role name that is not a role", () => {
    expect(rejection(decodeAgent({ mode: "subagent", role: "judgge" }))).toContain("judgge")
  })

  test("leaves an agent that opts into nothing alone", () => {
    const decoded = accepted(decodeAgent({ mode: "subagent" }))
    expect(decoded.role).toBeUndefined()
    expect(decoded.options).toEqual({})
  })
})
