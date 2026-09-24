// The first ACP session picks its default model without scanning history. The
// preference order is a contract: configured model > OpenCode Zen > best sorted.
// The Zen step is keyed on a provider ID, and a wrong ID makes the step VANISH
// silently (it just falls through to "best sorted"), so the only proof that the
// step works is a case where Zen and "best sorted" disagree.
import { describe, expect, test } from "bun:test"
import { defaultModelFromConfig } from "@/acp/service"
import type { Provider } from "@/provider/provider"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

// Directory.DefaultModel carries BRANDED ids, so a plain string literal will
// not compare. Build the expectation through the same constructors the code uses.
const expected = (providerID: string, modelID: string) => ({
  providerID: ProviderV2.ID.make(providerID),
  modelID: ModelV2.ID.make(modelID),
})

function provider(id: string, modelIDs: string[]) {
  return {
    id,
    name: id,
    models: Object.fromEntries(modelIDs.map((modelID) => [modelID, { id: modelID, providerID: id }])),
  } as unknown as Provider.Info
}

// Provider.sort orders by model id DESCENDING when no priority family matches,
// so "zzz-model" is the "best sorted" model and "aaa-model" is not. The Zen
// provider therefore only wins if it is found by ID.
function providers(entries: Provider.Info[]) {
  return Object.fromEntries(entries.map((entry) => [entry.id, entry])) as Record<ProviderV2.ID, Provider.Info>
}

describe("defaultModelFromConfig", () => {
  test("prefers the OpenCode Zen provider over the best-sorted model", () => {
    const result = defaultModelFromConfig(
      undefined,
      providers([provider("opencode", ["aaa-model"]), provider("anthropic", ["zzz-model"])]),
    )
    expect(result).toEqual(expected("opencode", "aaa-model"))
  })

  test("prefers OpenCode Go models only through the best-sorted fallback", () => {
    // `opencode-go` is a separate provider and is NOT the Zen preference; it
    // competes on merit. This pins the preference to the one ID, so a future
    // prefix match cannot quietly widen it.
    const result = defaultModelFromConfig(
      undefined,
      providers([provider("opencode-go", ["aaa-model"]), provider("anthropic", ["zzz-model"])]),
    )
    expect(result).toEqual(expected("anthropic", "zzz-model"))
  })

  test("an explicitly configured model still wins over Zen", () => {
    const result = defaultModelFromConfig(
      "anthropic/zzz-model",
      providers([provider("opencode", ["aaa-model"]), provider("anthropic", ["zzz-model"])]),
    )
    expect(result).toEqual(expected("anthropic", "zzz-model"))
  })

  test("falls back to the best-sorted model when Zen is absent", () => {
    const result = defaultModelFromConfig(
      undefined,
      providers([provider("google", ["aaa-model"]), provider("anthropic", ["zzz-model"])]),
    )
    expect(result).toEqual(expected("anthropic", "zzz-model"))
  })

  test("returns undefined when there is nothing to choose from", () => {
    expect(defaultModelFromConfig(undefined, providers([]))).toBeUndefined()
  })

  // A fresh install whose config still names a provider that was removed (or
  // that was never enabled -- Zen, before the fork stopped autoloading it) used
  // to get that name handed back as the session's model. It resolves to nothing,
  // so it is a phantom: the picker and the composer footer showed a model the
  // session could never reach. The empty state is the honest answer.
  test("a configured model that resolves against NO provider is not handed back", () => {
    expect(defaultModelFromConfig("opencode/big-pickle", providers([]))).toBeUndefined()
  })

  // The mirror case, so the rule above cannot be read as "configured is ignored":
  // it still WINS whenever the provider really is there.
  test("a configured model that DOES resolve still wins", () => {
    const result = defaultModelFromConfig(
      "anthropic/zzz-model",
      providers([provider("anthropic", ["zzz-model"])]),
    )
    expect(result).toEqual(expected("anthropic", "zzz-model"))
  })
})
