// t-ty02bb. Owner test of 0.4.170: the picker took `claude-subscription/haiku`,
// and the first prompt failed with "Native LLM request adapter requires a base
// URL for claude-subscription/haiku".
//
// THE CHAIN. After a pick, the extension persists the model into origami.json
// (DashboardPanel `setModel` -> firstFold.writeModelConfig), which writes a
// `claude-subscription` provider block with no npm and no URL. The config pass
// in provider.ts then built that block's rows as `@ai-sdk/openai-compatible`
// (the protocol default) with context 0, and those rows REPLACED the family's
// own rows. Routing is by `api.npm`, so the request never reached Gate B: it
// went to the OpenAI-compatible adapter, which throws for a missing base URL.
//
// The block below is the one read from the owner's origami.json on 2026-09-23
// (the "LM Studio" name is the setModel fallback for a provider with no name).
// Every CLI here is the fake from packages/llm; nothing contacts Anthropic.

import { afterEach, beforeEach, expect } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ModelsDev } from "@origami/core/models-dev"
import { FSUtil } from "@origami/core/fs-util"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { ClaudeCli, LLMClient, RequestExecutor } from "@origami/llm/route"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { ClaudeSubscription } from "@/provider/claude-subscription"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { LLMNativeRoute } from "@/session/llm/native-route"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const FIXTURES = path.resolve(import.meta.dir, "../../../llm/test/fixtures/claude-cli")
const FAKE = [process.execPath, path.join(FIXTURES, "fake-claude.ts")]
const ID = ProviderV2.ID.make(ClaudeSubscription.PROVIDER_ID)

const layerWith = (experimentalClaudeSubscription: boolean) =>
  LayerNode.compile(
    LayerNode.group([
      Provider.node,
      FSUtil.node,
      Env.node,
      Config.node,
      Auth.node,
      Plugin.node,
      ModelsDev.node,
      RuntimeFlags.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({ experimentalClaudeSubscription })]],
  )
const subscription = testEffect(layerWith(true))
const flagOff = testEffect(layerWith(false))

const client = Effect.runSync(
  Effect.gen(function* () {
    return yield* LLMClient.Service
  }).pipe(
    Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))))),
  ),
)

const vision = { attachment: true, modalities: { input: ["text", "image"] } }
const ownerConfig = {
  model: "claude-subscription/haiku",
  provider: {
    "claude-subscription": {
      name: "LM Studio",
      options: {},
      models: { opus: vision, sonnet: vision, haiku: { ...vision, name: "haiku" }, fable: vision },
    },
  },
} as any

/** Gate B answers from the fake CLI at `version`; the provider list reads that memoised answer. */
const seedFakeCli = async (version: string) => {
  const log = mkdtempSync(path.join(tmpdir(), "fake-claude-config-"))
  const scenario = path.join(log, "scenario.json")
  writeFileSync(scenario, JSON.stringify({ version }))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => ClaudeCli.envConflicts({ [key]: process.env[key] }).length === 0),
  )
  ClaudeSubscription.resetMemo()
  await ClaudeSubscription.providerInfo({ command: FAKE, env: { ...env, FAKE_SCENARIO: scenario, FAKE_LOG: log } })
  return log
}

let fetches = 0
const realFetch = globalThis.fetch
beforeEach(() => {
  fetches = 0
  globalThis.fetch = Object.assign((...args: Parameters<typeof fetch>) => {
    fetches++
    return realFetch(...args)
  }, realFetch)
})
afterEach(async () => {
  globalThis.fetch = realFetch
  ClaudeSubscription.resetMemo()
  await disposeAllInstances()
})

subscription.instance(
  "a config block for the family keeps the family's routing: an unready CLI is refused with Gate B's reason, never the base-URL error",
  Effect.gen(function* () {
    yield* Effect.promise(() => seedFakeCli("2.1.198 (Claude Code)"))
    const providers = yield* Provider.use.list()
    const model = yield* Provider.use.getModel(ID, ModelV2.ID.make("haiku"))
    const native = LLMNativeRuntime.stream({
      model,
      provider: providers[ID]!,
      auth: undefined,
      llmClient: client,
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      headers: {},
      abort: new AbortController().signal,
    })
    expect(native.type).toBe("unsupported")
    expect(native.type === "unsupported" && native.reason).toContain(
      `Claude CLI 2.1.198 is below the qualified floor ${ClaudeSubscription.VERSION_FLOOR}`,
    )

    // The route is the family's, whatever the block left out.
    expect(model.api.npm).toBe(ClaudeSubscription.NPM)
    // The family's own window and effort ladder survive the merge (the config
    // pass used to write context 0, which switches compaction off).
    expect(model.limit.context).toBe(200_000)
    expect(Object.keys(model.variants ?? {})).toContain("high")
    // What the block DID say still applies.
    expect(model.capabilities.input.image).toBe(true)

    // The session then falls back to the AI SDK path; its model for this family
    // refuses with the same reason and runs nothing.
    const language = yield* Provider.use.getLanguage(model)
    const refused = yield* Effect.promise(() =>
      Promise.resolve(language.doStream({ prompt: [] } as any)).then(
        () => undefined,
        (error: unknown) => error,
      ),
    )
    expect(String(refused)).toContain("claude update")
    expect(String(refused)).not.toContain("base URL")
    expect(fetches).toBe(0)
  }),
  { config: ownerConfig },
)

subscription.instance(
  "no config block: the family's rows are listed as built",
  Effect.gen(function* () {
    const log = yield* Effect.promise(() => seedFakeCli("2.1.198 (Claude Code)"))
    const model = yield* Provider.use.getModel(ID, ModelV2.ID.make("sonnet"))
    expect(model.api.npm).toBe(ClaudeSubscription.NPM)
    expect(model.limit.context).toBe(200_000)
    // Below the floor the handshake never starts: no CLI process was spawned for a picker.
    expect(() => readFileSync(path.join(log, "pids.log"))).toThrow()
  }),
)

// After Disconnect the flag is off, but origami.json still holds the block and
// `model: claude-subscription/haiku` (the extension persists every pick), so
// every new chat asks for that model.
flagOff.instance(
  "flag off with the block still in config: the request says the route is off, never the base-URL error, and no CLI is asked",
  Effect.gen(function* () {
    ClaudeSubscription.resetMemo()
    const providers = yield* Provider.use.list()
    const model = yield* Provider.use.getModel(ID, ModelV2.ID.make("haiku"))
    expect(model.api.npm).toBe(ClaudeSubscription.NPM)
    // Gate A is off, so the session takes the AI SDK path, whose model refuses.
    expect(LLMNativeRoute.enabled(model, { experimentalNativeLlm: false, nativeLlmFamilies: "" })).toBe(false)
    expect(LLMNativeRuntime.status({ model, provider: providers[ID]!, auth: undefined })).toMatchObject({
      type: "unsupported",
      reason: expect.stringContaining("off for this chat"),
    })
    const language = yield* Provider.use.getLanguage(model)
    const refused = yield* Effect.promise(() =>
      Promise.resolve(language.doStream({ prompt: [] } as any)).then(
        () => undefined,
        (error: unknown) => error,
      ),
    )
    expect(String(refused)).toContain("off for this chat")
    expect(fetches).toBe(0)
  }),
  { config: ownerConfig },
)

flagOff.instance(
  "flag off and no block: the family does not exist",
  Effect.gen(function* () {
    const providers = yield* Provider.use.list()
    expect(providers[ID]).toBeUndefined()
  }),
)
