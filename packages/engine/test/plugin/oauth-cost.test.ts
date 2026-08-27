import { describe, expect, test } from "bun:test"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import { XaiAuthPlugin } from "@/plugin/xai"

/**
 * A subscription turn costs nothing per token, but the model catalogue the
 * engine ships is models.dev's PUBLIC price list - it has no idea which
 * credential the session is holding. Each subscription plugin is what corrects
 * that, in its `provider.models` hook, and a plugin that forgets bills the user
 * for turns their subscription already paid for (owner report: a Grok OAuth
 * chat accrued $3.26 and tripped the monthly cap).
 */
const oauth = { auth: { type: "oauth", refresh: "RT", access: "AT", expires: Date.now() + 60_000 } as never }
const apiKey = { auth: { type: "api", key: "sk-test" } as never }

/** A catalogue entry priced the way models.dev prices a paid API model. */
const priced = (id: string) => ({
  id,
  providerID: "test",
  api: { id, url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
  name: id,
  options: {},
  cost: { input: 3, output: 15, cache: { read: 0.75, write: 1.5 } },
  limit: { context: 256_000, output: 32_000 },
})

const providerOf = (id: string, models: Record<string, ReturnType<typeof priced>>) => ({ id, models }) as never

describe("subscription plugins zero their model costs", () => {
  test("xai charges nothing for a Grok OAuth session", async () => {
    const hooks = await XaiAuthPlugin({} as never)
    const models = await hooks.provider!.models!(
      providerOf("xai", { "grok-4": priced("grok-4"), "grok-4-fast": priced("grok-4-fast") }),
      oauth,
    )

    // EVERY model, and every one of the four price fields: a cache-read price
    // left behind still accrues, just more slowly.
    expect(Object.keys(models).toSorted()).toEqual(["grok-4", "grok-4-fast"])
    for (const model of Object.values(models)) {
      expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
    }
  })

  test("xai leaves the published prices alone for an API-key session", async () => {
    const hooks = await XaiAuthPlugin({} as never)
    const models = await hooks.provider!.models!(providerOf("xai", { "grok-4": priced("grok-4") }), apiKey)

    // A pasted API key IS billed per token, so zeroing here would hide real spend.
    expect(models["grok-4"].cost).toEqual({ input: 3, output: 15, cache: { read: 0.75, write: 1.5 } })
  })

  test("codex charges nothing for a ChatGPT OAuth session", async () => {
    const hooks = await CodexAuthPlugin({} as never)
    const models = await hooks.provider!.models!(providerOf("openai", { "gpt-5.5": priced("gpt-5.5") }), oauth)

    expect(models["gpt-5.5"].cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  })

  test("codex leaves the published prices alone for an API-key session", async () => {
    const hooks = await CodexAuthPlugin({} as never)
    const models = await hooks.provider!.models!(providerOf("openai", { "gpt-5.5": priced("gpt-5.5") }), apiKey)

    expect(models["gpt-5.5"].cost).toEqual({ input: 3, output: 15, cache: { read: 0.75, write: 1.5 } })
  })
})
