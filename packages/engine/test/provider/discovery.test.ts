import { describe, expect, test } from "bun:test"
import { discoveryKey, memoizeDiscovery, resetDiscoveryCache, runDiscoveryLoaders } from "../../src/provider/discovery"
import type { Model } from "../../src/provider/provider"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"

function model(providerID: string, id: string): Model {
  return {
    id: ModelV2.ID.make(id),
    providerID: ProviderV2.ID.make(providerID),
    name: id,
    family: "",
    api: { id, url: "", npm: "@ai-sdk/openai" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1000, output: 100 },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
  }
}

function providers(rows: Record<string, string[]>) {
  return Object.fromEntries(
    Object.entries(rows).map(([id, ids]) => [
      id,
      { models: Object.fromEntries(ids.map((m) => [m, model(id, m)])) },
    ]),
  )
}

describe("provider discovery loop", () => {
  test("runs EVERY registered loader, not only the one it was written for", async () => {
    // The regression: the loop read `discoveryLoaders["gitlab"]` by name, so a
    // second provider that knew how to list its own models was never asked.
    const target = providers({ openai: [], xai: [] })
    await runDiscoveryLoaders({
      loaders: {
        openai: async () => ({ "gpt-6-astra": model("openai", "gpt-6-astra") }),
        xai: async () => ({ "grok-9": model("xai", "grok-9") }),
      },
      providers: target,
      isAllowed: () => true,
    })
    expect(Object.keys(target["openai"]!.models)).toEqual(["gpt-6-astra"])
    expect(Object.keys(target["xai"]!.models)).toEqual(["grok-9"])
  })

  // origami_change (t-48ffvz): the ADVERTISED effort ladder wins over the one an
  // existing row already carries.
  test("an advertised ladder replaces the ladder a seeded row already had", async () => {
    // The case this exists for: `oauthConnections.ts` seeds gpt-5.5 into
    // origami.json, so the row is already present when discovery answers and
    // never reached the merge at all. Its ladder came from the name-regex table
    // in transform.ts - a table that stops at `xhigh` and cannot know what THIS
    // account is served. The account's own list is the better answer.
    const target = providers({ openai: ["gpt-5.5"] })
    target["openai"]!.models["gpt-5.5"]!.variants = { none: {}, low: {}, medium: {}, high: {}, xhigh: {} }
    const advertised = model("openai", "gpt-5.5")
    advertised.variants = { medium: {}, low: {}, high: {}, max: {} }
    await runDiscoveryLoaders({
      loaders: { openai: async () => ({ "gpt-5.5": advertised }) },
      providers: target,
      isAllowed: () => true,
    })
    expect(Object.keys(target["openai"]!.models["gpt-5.5"]!.variants ?? {})).toEqual(["medium", "low", "high", "max"])
    // Only `variants` moves. Discovery is a source of ROWS, not an editor of
    // the rest of one - a seeded name or limit must survive it.
    expect(target["openai"]!.models["gpt-5.5"]!.limit.context).toBe(1000)
  })

  test("a loader that publishes NO ladder never erases the one the row had", async () => {
    // anthropic and xai both leave `variants` undefined on a discovered row, so
    // reading that as "this model has no reasoning tiers" would empty the
    // effort control on every model they list.
    const target = providers({ xai: ["grok-9"] })
    target["xai"]!.models["grok-9"]!.variants = { low: {}, high: {} }
    await runDiscoveryLoaders({
      loaders: { xai: async () => ({ "grok-9": model("xai", "grok-9") }) },
      providers: target,
      isAllowed: () => true,
    })
    expect(Object.keys(target["xai"]!.models["grok-9"]!.variants ?? {})).toEqual(["low", "high"])
  })

  test("one loader throwing costs only its own provider its rows", async () => {
    const target = providers({ openai: [], xai: ["grok-seed"] })
    const failures: string[] = []
    await runDiscoveryLoaders({
      loaders: {
        xai: async () => {
          throw new Error("401")
        },
        openai: async () => ({ "gpt-6-astra": model("openai", "gpt-6-astra") }),
      },
      providers: target,
      isAllowed: () => true,
      onError: (id) => failures.push(id),
    })
    expect(failures).toEqual(["xai"])
    // The thrower keeps its seed, untouched...
    expect(Object.keys(target["xai"]!.models)).toEqual(["grok-seed"])
    // ...and the loader registered AFTER it still ran.
    expect(Object.keys(target["openai"]!.models)).toEqual(["gpt-6-astra"])
  })

  test("never overwrites a row the config or catalogue already declared", async () => {
    const target = providers({ openai: ["gpt-5.5"] })
    target["openai"]!.models["gpt-5.5"]!.name = "declared by the operator"
    await runDiscoveryLoaders({
      loaders: {
        openai: async () => {
          const discovered = model("openai", "gpt-5.5")
          discovered.name = "discovered"
          return { "gpt-5.5": discovered }
        },
      },
      providers: target,
      isAllowed: () => true,
    })
    expect(target["openai"]!.models["gpt-5.5"]!.name).toBe("declared by the operator")
  })

  // origami_change (t-d94t8t): a bare config block for a generic OpenAI-compatible
  // endpoint has no models.dev row, so its declared model sits at limit.context 0
  // until something backfills it.
  test("a discovered positive context backfills an existing row still sitting at 0", async () => {
    const target = providers({ spark1: ["Qwen/Qwen3.8-Flash-Next"] })
    target["spark1"]!.models["Qwen/Qwen3.8-Flash-Next"]!.limit.context = 0
    const discovered = model("spark1", "Qwen/Qwen3.8-Flash-Next")
    discovered.limit.context = 262144
    await runDiscoveryLoaders({
      loaders: { spark1: async () => ({ "Qwen/Qwen3.8-Flash-Next": discovered }) },
      providers: target,
      isAllowed: () => true,
    })
    expect(target["spark1"]!.models["Qwen/Qwen3.8-Flash-Next"]!.limit.context).toBe(262144)
  })

  test("a declared positive context is never overruled by a discovered one", async () => {
    const target = providers({ spark1: ["m"] })
    target["spark1"]!.models["m"]!.limit.context = 8000 // the operator's own override
    const discovered = model("spark1", "m")
    discovered.limit.context = 262144
    await runDiscoveryLoaders({
      loaders: { spark1: async () => ({ m: discovered }) },
      providers: target,
      isAllowed: () => true,
    })
    expect(target["spark1"]!.models["m"]!.limit.context).toBe(8000)
  })

  test("a disabled provider is not asked at all — its credential stays off the wire", async () => {
    const target = providers({ openai: [] })
    let called = false
    await runDiscoveryLoaders({
      loaders: {
        openai: async () => {
          called = true
          return {}
        },
      },
      providers: target,
      isAllowed: () => false,
    })
    expect(called).toBe(false)
  })

  test("a loader for a provider with no row is skipped, not crashed on", async () => {
    await runDiscoveryLoaders({
      loaders: { openai: async () => ({ "gpt-6-astra": model("openai", "gpt-6-astra") }) },
      providers: {},
      isAllowed: () => true,
    })
    // Reaching here without throwing IS the assertion.
    expect(true).toBe(true)
  })
})

describe("discovery memo", () => {
  test("a second call inside the TTL does not reach the loader", async () => {
    resetDiscoveryCache()
    let calls = 0
    let clock = 0
    const load = memoizeDiscovery(
      "openai",
      async () => {
        calls++
        return {}
      },
      { ttlMs: 1000, now: () => clock },
    )
    await load()
    clock = 999
    await load()
    expect(calls).toBe(1)
  })

  test("the answer expires — past the TTL the loader is asked again", async () => {
    resetDiscoveryCache()
    let calls = 0
    let clock = 0
    const load = memoizeDiscovery(
      "openai",
      async () => {
        calls++
        return {}
      },
      { ttlMs: 1000, now: () => clock },
    )
    await load()
    clock = 1001
    await load()
    expect(calls).toBe(2)
  })

  test("survives the provider list being rebuilt — a fresh wrapper reuses the answer", async () => {
    // This is the whole point of the module-scope cache. `provider_refresh`
    // drops the provider list, which is where the wrapper was created, so a
    // per-build cache would be empty on every single picker open.
    resetDiscoveryCache()
    let calls = 0
    const make = () =>
      memoizeDiscovery(
        "openai",
        async () => {
          calls++
          return {}
        },
        { ttlMs: 1000, now: () => 0 },
      )
    await make()()
    await make()()
    expect(calls).toBe(1)
  })

  test("concurrent callers share one request", async () => {
    resetDiscoveryCache()
    let calls = 0
    const load = memoizeDiscovery("openai", async () => {
      calls++
      await new Promise((r) => setTimeout(r, 5))
      return {}
    })
    await Promise.all([load(), load(), load()])
    expect(calls).toBe(1)
  })

  test("a failure is NOT cached — the next call may still succeed", async () => {
    resetDiscoveryCache()
    let calls = 0
    const load = memoizeDiscovery("openai", async () => {
      calls++
      if (calls === 1) throw new Error("token was mid-refresh")
      return { "gpt-6-astra": model("openai", "gpt-6-astra") }
    })
    await expect(load()).rejects.toThrow("token was mid-refresh")
    expect(Object.keys(await load())).toEqual(["gpt-6-astra"])
  })

  test("two providers do not share one answer", async () => {
    resetDiscoveryCache()
    const a = memoizeDiscovery("openai", async () => ({ "gpt-6-astra": model("openai", "gpt-6-astra") }))
    const b = memoizeDiscovery("xai", async () => ({ "grok-9": model("xai", "grok-9") }))
    expect(Object.keys(await a())).toEqual(["gpt-6-astra"])
    expect(Object.keys(await b())).toEqual(["grok-9"])
  })
})

describe("discovery cache key", () => {
  test("a different credential is a different key — no cross-account bleed", () => {
    // Signing out and back in on another account must not be served the
    // previous account's model list for the rest of the TTL. `provider_refresh`
    // cannot be the cure: the picker fires it on every open, so clearing there
    // would delete the memo entirely.
    expect(discoveryKey("openai", "token-a")).not.toBe(discoveryKey("openai", "token-b"))
    expect(discoveryKey("openai", "token-a")).toBe(discoveryKey("openai", "token-a"))
    expect(discoveryKey("openai", "token-a")).not.toBe(discoveryKey("xai", "token-a"))
  })

  test("the credential itself never becomes the key", () => {
    const secret = "sk-this-would-be-a-real-looking-token"
    expect(discoveryKey("openai", secret)).not.toContain(secret)
    expect(discoveryKey("openai", secret).length).toBeLessThan(secret.length + 10)
  })

  test("signed out is its own key, not the empty one", () => {
    expect(discoveryKey("openai", undefined)).toBe("openai:anonymous")
    expect(discoveryKey("openai", "")).toBe("openai:anonymous")
  })

  test("a re-keyed provider actually re-asks", async () => {
    resetDiscoveryCache()
    let calls = 0
    const load = (secret: string) =>
      memoizeDiscovery(discoveryKey("openai", secret), async () => {
        calls++
        return {}
      })
    await load("token-a")()
    await load("token-a")()
    expect(calls).toBe(1)
    await load("token-b")()
    expect(calls).toBe(2)
  })
})
