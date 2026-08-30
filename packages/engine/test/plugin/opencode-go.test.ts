import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { OpencodeGoCostPlugin } from "@/plugin/opencode-go"

/**
 * OpenCode GO is FLAT-RATE, so a GO turn must accrue no cost at all.
 *
 * The shipped models.dev catalogue prices `opencode-go` at the gateway's public
 * per-token rates — `deepseek-v4-flash` at 0.14 in / 0.28 out, and three models
 * carry a `tiers` block on top (read from
 * test/tool/fixtures/models-api.json, the same catalogue the engine ships). The
 * fixtures below mirror those two shapes so the test measures the real input
 * class, not an invented one.
 *
 * OpenCode ZEN (`opencode`) is the other half of the requirement: it shares the
 * host and is METERED per token, so its prices must survive untouched.
 */

/** A GO model priced the way models.dev prices `deepseek-v4-flash`. */
const priced = (id: string) => ({
  id,
  providerID: "opencode-go",
  api: { id, url: "https://opencode.ai/zen/go/v1", npm: "@ai-sdk/openai-compatible" },
  name: id,
  options: {},
  cost: { input: 0.14, output: 0.28, cache: { read: 0.0028, write: 0 } },
  limit: { context: 256_000, output: 32_000 },
})

/**
 * A GO model priced the way models.dev prices `qwen3.7-plus`: base rates PLUS a
 * context tier and a 200k override.
 *
 * These two fields are the reason the hook REPLACES `cost` instead of merging
 * into it — `session/session.ts` prefers a matching tier over the base rates, so
 * a tier left behind keeps charging exactly the long-context turns that cost the
 * most.
 */
const tiered = (id: string) => ({
  ...priced(id),
  cost: {
    input: 0.4,
    output: 1.6,
    cache: { read: 0.04, write: 0.5 },
    tiers: [{ input: 1.2, output: 4.8, cache: { read: 0.12, write: 1.5 }, tier: { type: "context", size: 256_000 } }],
    experimentalOver200K: { input: 1.2, output: 4.8, cache: { read: 0.12, write: 1.5 } },
  },
})

const providerOf = (id: string, models: Record<string, unknown>) => ({ id, models }) as never

const oauth = { auth: { type: "oauth", refresh: "RT", access: "AT", expires: Date.now() + 60_000 } as never }
const apiKey = { auth: { type: "api", key: "sk-not-a-real-go-key" } as never }
const noCredential = {} as never

describe("opencode-go zeroes every model cost, unconditionally", () => {
  test("every model, every price field, on a plain catalogue", async () => {
    const hooks = await OpencodeGoCostPlugin({} as never)
    const models = await hooks.provider!.models!(
      providerOf("opencode-go", { "deepseek-v4-flash": priced("deepseek-v4-flash"), "glm-5.1": priced("glm-5.1") }),
      apiKey,
    )

    expect(Object.keys(models).toSorted()).toEqual(["deepseek-v4-flash", "glm-5.1"])
    for (const model of Object.values(models)) {
      // A cache-read price left behind still accrues, just more slowly.
      expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
    }
  })

  test("a tiered model loses its tiers AND its 200k override, not just its base rates", async () => {
    const hooks = await OpencodeGoCostPlugin({} as never)
    const models = await hooks.provider!.models!(providerOf("opencode-go", { "qwen3.7-plus": tiered("qwen3.7-plus") }), apiKey)

    const cost = models["qwen3.7-plus"]!.cost as Record<string, unknown>
    expect(cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
    expect("tiers" in cost).toBe(false)
    expect("experimentalOver200K" in cost).toBe(false)
  })

  test("the credential type does NOT gate it — GO has no metered mode to preserve", async () => {
    // This is the one difference from xai.ts and codex.ts, which zero only for
    // an OAuth session because their API keys are genuinely billed. A GO API key
    // IS the flat-rate plan, so gating on `ctx.auth` here would leave the common
    // case (a key pasted into origami.json) priced.
    const hooks = await OpencodeGoCostPlugin({} as never)
    for (const ctx of [apiKey, oauth, noCredential]) {
      const models = await hooks.provider!.models!(providerOf("opencode-go", { "glm-5.1": priced("glm-5.1") }), ctx)
      expect(models["glm-5.1"]!.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
    }
  })

  test("everything except cost survives — this is a price correction, not a catalogue rewrite", async () => {
    const hooks = await OpencodeGoCostPlugin({} as never)
    const before = priced("deepseek-v4-flash")
    const models = await hooks.provider!.models!(providerOf("opencode-go", { "deepseek-v4-flash": before }), apiKey)

    const after = models["deepseek-v4-flash"]!
    expect(after.limit).toEqual(before.limit)
    expect(after.api).toEqual(before.api as never)
    expect(after.name).toBe(before.name)
  })
})

describe("OpenCode ZEN keeps its catalogue prices", () => {
  /**
   * The dispatch rule, mirrored from `provider/provider.ts` (the plugin loop:
   * it reads `database[hook.provider.id]` and skips any id the catalogue does
   * not hold). Mirrored rather than driven end-to-end because the real loop
   * needs the whole Provider layer; the drift guard below is what keeps the
   * mirror honest.
   */
  const applyHooks = (
    database: Record<string, { models: Record<string, unknown> }>,
    hooks: Array<{ id: string; models: (p: never, c: never) => Promise<Record<string, unknown>> }>,
  ) =>
    Promise.all(
      hooks.map(async (hook) => {
        const provider = database[hook.id]
        if (!provider) return
        provider.models = await hook.models(provider as never, {} as never)
      }),
    )

  test("a Zen model beside a GO model keeps its price while the GO one is zeroed", async () => {
    const hooks = await OpencodeGoCostPlugin({} as never)
    const database = {
      opencode: { models: { "deepseek-v4-flash": priced("deepseek-v4-flash") } },
      "opencode-go": { models: { "deepseek-v4-flash": priced("deepseek-v4-flash") } },
    }
    await applyHooks(database, [hooks.provider as never])

    // Zen is billed per token — zeroing it would hide real spend, which is the
    // exact defect this whole feature exists to fix in the other direction.
    expect((database["opencode"].models["deepseek-v4-flash"] as { cost: unknown }).cost).toEqual({
      input: 0.14,
      output: 0.28,
      cache: { read: 0.0028, write: 0 },
    })
    expect((database["opencode-go"].models["deepseek-v4-flash"] as { cost: unknown }).cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
  })

  test("the plugin's id is the whole guard, and it is exactly `opencode-go`", async () => {
    const hooks = await OpencodeGoCostPlugin({} as never)
    expect(hooks.provider!.id).toBe("opencode-go")
    // No auth hook: this plugin corrects prices and owns no sign-in flow.
    expect(hooks.auth).toBeUndefined()
  })

  test("DRIFT GUARD: provider.ts still dispatches the models hook by that id", () => {
    // If the loop ever applied a hook to every provider, or keyed on something
    // other than `p.id`, the mirror above would silently stop describing it and
    // Zen would start being zeroed with nothing failing.
    const src = readFileSync(path.join(import.meta.dir, "../../src/provider/provider.ts"), "utf8")
    expect(src).toContain("const providerID = ProviderV2.ID.make(p.id)")
    expect(src).toContain("const provider = database[providerID]")
  })

  test("the plugin is REGISTERED — an unregistered correction corrects nothing", () => {
    const src = readFileSync(path.join(import.meta.dir, "../../src/plugin/index.ts"), "utf8")
    expect(src).toContain("OpencodeGoCostPlugin")
    // Inside internalPlugins(), not merely imported.
    const internals = src.slice(src.indexOf("function internalPlugins"), src.indexOf("function isServerPlugin"))
    expect(internals).toContain("OpencodeGoCostPlugin")
  })
})
