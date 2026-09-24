import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import { ProviderEffortDemotion } from "@/provider/effort-demotion"

// ---------------------------------------------------------------------------
// The persisted record of tiers a model has REFUSED (t-48ffvz).
//
// Every case here is a rule the retry and the picker both depend on, asserted
// against the store's observable answers rather than its file format: what the
// ladder becomes, what "one tier down" resolves to, and whether the answer is
// still there after the process that wrote it is gone.
// ---------------------------------------------------------------------------

beforeEach(() => ProviderEffortDemotion.reset())
afterEach(() => ProviderEffortDemotion.reset())

const LADDER = ["low", "medium", "high", "xhigh"]

describe("provider.effort-demotion store", () => {
  test("a model with no refusals keeps its whole ladder", () => {
    expect(ProviderEffortDemotion.demoted("openai", "gpt-5.6-sol")).toEqual([])
    expect(ProviderEffortDemotion.ladder("openai", "gpt-5.6-sol", LADDER)).toEqual(LADDER)
  })

  test("a recorded tier leaves the ladder, and only for that model", () => {
    ProviderEffortDemotion.record("openai", "gpt-5.6-sol", "xhigh")
    expect(ProviderEffortDemotion.ladder("openai", "gpt-5.6-sol", LADDER)).toEqual(["low", "medium", "high"])
    expect(ProviderEffortDemotion.ladder("openai", "gpt-5.5", LADDER)).toEqual(LADDER)
    expect(ProviderEffortDemotion.ladder("azure", "gpt-5.6-sol", LADDER)).toEqual(LADDER)
  })

  test("the demotion survives a restart", () => {
    ProviderEffortDemotion.record("openai", "gpt-5.6-sol", "xhigh")
    // Everything this process learned, forgotten - but not the file. This is
    // what a new engine process sees on the next launch.
    ProviderEffortDemotion.forget()
    expect(ProviderEffortDemotion.demoted("openai", "gpt-5.6-sol")).toEqual(["xhigh"])
    expect(ProviderEffortDemotion.ladder("openai", "gpt-5.6-sol", LADDER)).toEqual(["low", "medium", "high"])
  })

  test("a store that cannot be parsed reads as no demotions rather than throwing", () => {
    ProviderEffortDemotion.record("openai", "gpt-5.6-sol", "xhigh")
    fs.writeFileSync(ProviderEffortDemotion.file(), "{ not json")
    ProviderEffortDemotion.forget()
    expect(ProviderEffortDemotion.demoted("openai", "gpt-5.6-sol")).toEqual([])
  })

  test("the ladder is NEVER emptied, even when every tier has been refused", () => {
    for (const tier of LADDER) ProviderEffortDemotion.record("openai", "gpt-5.6-sol", tier)
    // Returning [] here would leave the model with no reasoning control at all
    // and send no effort; the whole list comes back instead, which is exactly
    // where the engine stood before any demotion.
    expect(ProviderEffortDemotion.ladder("openai", "gpt-5.6-sol", LADDER)).toEqual(LADDER)
  })

  test("filterVariants drops the demoted entries and keeps the rest intact", () => {
    ProviderEffortDemotion.record("openai", "gpt-5.6-sol", "xhigh")
    const variants = {
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      xhigh: { reasoningEffort: "xhigh" },
    }
    expect(ProviderEffortDemotion.filterVariants("openai", "gpt-5.6-sol", variants)).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
    })
    // Untouched models are handed back the SAME object, so a build that demotes
    // nothing allocates nothing.
    expect(ProviderEffortDemotion.filterVariants("openai", "gpt-5.5", variants)).toBe(variants)
    expect(ProviderEffortDemotion.filterVariants("openai", "gpt-5.6-sol", undefined)).toBeUndefined()
  })
})

describe("provider.effort-demotion ladder arithmetic", () => {
  test("below is the strongest tier that is still weaker", () => {
    expect(ProviderEffortDemotion.below("xhigh", LADDER)).toBe("high")
    expect(ProviderEffortDemotion.below("medium", LADDER)).toBe("low")
    // A ladder with a hole steps over it rather than stopping.
    expect(ProviderEffortDemotion.below("xhigh", ["low", "medium"])).toBe("medium")
  })

  test("below never answers with the tier itself, and never with a stronger one", () => {
    expect(ProviderEffortDemotion.below("low", LADDER)).toBeUndefined()
    expect(ProviderEffortDemotion.below("low", ["low"])).toBeUndefined()
  })

  test("a tier this engine does not know has no rank, so nothing is below it", () => {
    expect(ProviderEffortDemotion.below("turbo", LADDER)).toBeUndefined()
  })

  test("replacement carries a WITHDRAWN tier that has nothing below it up to the weakest", () => {
    // This is the `none` / `minimal` case from t-46a74d: a session still holds
    // a tier the ladder no longer offers, and the alternative to answering is
    // sending no effort at all and letting the endpoint pick.
    expect(ProviderEffortDemotion.replacement("none", LADDER)).toBe("low")
    expect(ProviderEffortDemotion.replacement("minimal", LADDER)).toBe("low")
    expect(ProviderEffortDemotion.replacement("xhigh", LADDER)).toBe("high")
    expect(ProviderEffortDemotion.replacement("xhigh", [])).toBeUndefined()
  })
})
