// origami_change: a provider block declares the WIRE PROTOCOL it speaks, and a
// package this build does not ship is refused instead of downloaded.
//
// Three separate surfaces are proven here, because a defect in any one of them
// is invisible in the other two:
//   1. the config schema accepts `protocol` and refuses a value that is not one
//      of the five;
//   2. the mapping turns each protocol into the internal package id the rest of
//      the engine routes on, with model-level winning over provider-level;
//   3. an unknown `npm` fails at model load - and the installer is never called.

import { test, expect, spyOn } from "bun:test"
import { Effect, Exit } from "effect"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Npm } from "@origami/core/npm"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { ConfigParse } from "../../src/config/parse"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { BUNDLED_PROVIDER_IDS, Provider } from "@/provider/provider"
import { ProviderProtocol } from "@/provider/protocol"

// ---------------------------------------------------------------- config decode

test("config decode accepts protocol at provider level and at model level", () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    {
      provider: {
        mine: {
          protocol: "anthropic-messages",
          api: "http://127.0.0.1:1/v1",
          models: {
            "my-model": { provider: { protocol: "openai-chat" } },
          },
        },
      },
    },
    "test",
  )

  expect(config.provider?.["mine"]?.protocol).toBe("anthropic-messages")
  expect(config.provider?.["mine"]?.models?.["my-model"]?.provider?.protocol).toBe("openai-chat")
})

test("config decode rejects a protocol that is not one of the five", () => {
  expect(() => ConfigParse.schema(ConfigV1.Info, { provider: { mine: { protocol: "grpc" } } }, "test")).toThrow()
  // The model-level key is a separate struct and needs its own guard.
  expect(() =>
    ConfigParse.schema(
      ConfigV1.Info,
      { provider: { mine: { models: { m: { provider: { protocol: "grpc" } } } } } },
      "test",
    ),
  ).toThrow()
})

// ---------------------------------------------------------------------- mapping

test("every protocol maps to the internal package id the engine routes on", () => {
  const resolve = (protocol: string) =>
    ProviderProtocol.resolveProviderPackage({ providerID: "mine", provider: { protocol } })

  expect(resolve("openai-chat")).toBe("@ai-sdk/openai-compatible")
  expect(resolve("openai-responses")).toBe("@ai-sdk/openai")
  expect(resolve("anthropic-messages")).toBe("@ai-sdk/anthropic")
  expect(resolve("gemini")).toBe("@ai-sdk/google")
  expect(resolve("bedrock-converse")).toBe("@ai-sdk/amazon-bedrock")
  // The five names are the contract the config schema and the docs both state;
  // a sixth entry added here without a route is the defect this guards.
  expect(ProviderProtocol.PROTOCOLS).toEqual([
    "openai-chat",
    "openai-responses",
    "anthropic-messages",
    "gemini",
    "bedrock-converse",
  ])
})

test("a model-level protocol beats the provider-level one", () => {
  expect(
    ProviderProtocol.resolveProviderPackage({
      providerID: "mine",
      model: { protocol: "anthropic-messages" },
      provider: { protocol: "openai-chat" },
    }),
  ).toBe("@ai-sdk/anthropic")
})

test("a model-level declaration beats a provider-level one whichever key each uses", () => {
  expect(
    ProviderProtocol.resolveProviderPackage({
      providerID: "mine",
      model: { protocol: "gemini" },
      provider: { npm: "@ai-sdk/openai-compatible" },
    }),
  ).toBe("@ai-sdk/google")
  expect(
    ProviderProtocol.resolveProviderPackage({
      providerID: "mine",
      model: { npm: "@ai-sdk/anthropic" },
      provider: { protocol: "openai-chat" },
    }),
  ).toBe("@ai-sdk/anthropic")
})

test("protocol and npm in the same block is a config error", () => {
  expect(() =>
    ProviderProtocol.resolveProviderPackage({
      providerID: "mine",
      provider: { protocol: "openai-chat", npm: "@ai-sdk/openai" },
    }),
  ).toThrow(/choose one/)
  expect(() =>
    ProviderProtocol.resolveProviderPackage({
      providerID: "mine",
      modelID: "m",
      model: { protocol: "openai-chat", npm: "@ai-sdk/openai" },
    }),
  ).toThrow(/choose one/)
})

test("an unknown protocol string names the five accepted values", () => {
  expect(() => ProviderProtocol.resolveProviderPackage({ providerID: "mine", provider: { protocol: "grpc" } })).toThrow(
    /openai-chat, openai-responses, anthropic-messages, gemini, bedrock-converse/,
  )
})

test("with nothing declared the resolution falls back exactly as before", () => {
  expect(ProviderProtocol.resolveProviderPackage({ providerID: "mine" })).toBe("@ai-sdk/openai-compatible")
  expect(
    ProviderProtocol.resolveProviderPackage({
      providerID: "mine",
      fallback: [undefined, "@ai-sdk/xai", "@ai-sdk/openai"],
    }),
  ).toBe("@ai-sdk/xai")
  // An empty string is not a package id; it must not win over the entry behind it.
  expect(ProviderProtocol.resolveProviderPackage({ providerID: "mine", fallback: ["", "@ai-sdk/xai"] })).toBe(
    "@ai-sdk/xai",
  )
})

// --------------------------------------------------------------- catalog reach

// The shipped catalog names a provider package for some providers. Every one of
// them used to be installed on demand. Now the package has to be IN the build,
// so a catalog entry naming anything else is a provider that no longer loads.
// This test is the ledger of that: it fails when a catalog addition would
// silently stop working, and it fails again if one of the three below is fixed
// and nobody removes it from the list.
const NO_LONGER_LOADABLE = [
  "@aihubmix/ai-sdk-provider",
  "@jerome-benoit/sap-ai-provider-v2",
  "merge-gateway-ai-sdk-provider",
]

test("every provider package the shipped catalog names is either in the build or on the known-lost list", async () => {
  const catalog = (await Bun.file(new URL("../tool/fixtures/models-api.json", import.meta.url)).json()) as Record<
    string,
    { npm?: string; models?: Record<string, { provider?: { npm?: string } }> }
  >

  const named = new Map<string, string>()
  for (const [providerID, provider] of Object.entries(catalog)) {
    for (const npm of [provider.npm, ...Object.values(provider.models ?? {}).map((m) => m.provider?.npm)]) {
      if (npm) named.set(npm, providerID)
    }
  }

  const unreachable = [...named].filter(([npm]) => !BUNDLED_PROVIDER_IDS.includes(npm)).map(([npm]) => npm)
  expect(unreachable.sort()).toEqual([...NO_LONGER_LOADABLE].sort())
  // cloudflare-ai-gateway is the one that regressed while this change was
  // written: the package is a dependency of the build, it was simply missing
  // from the table, so removing the installer took the provider with it.
  expect(BUNDLED_PROVIDER_IDS).toContain("ai-gateway-provider")
})

// ------------------------------------------------------------------ model load

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

const providerID = ProviderV2.ID.make("mine")
const modelID = ModelV2.ID.make("my-model")

const load = () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(providerID, modelID)
    return { model, language: yield* provider.getLanguage(model) }
  })

it.live("an npm package this build does not ship fails at model load and installs nothing", () =>
  Effect.gen(function* () {
    const add = spyOn(Npm, "add")
    try {
      const exit = yield* provideTmpdirInstance(load, {
        config: providerConfig({ npm: "some-random-ai-provider" }),
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const text = failureText(exit)
      expect(text).toContain("some-random-ai-provider")
      expect(text).toContain("protocol")
      expect(text).toContain("openai-chat, openai-responses, anthropic-messages, gemini, bedrock-converse")
      // The whole point of the change: nothing was fetched or installed.
      expect(add).not.toHaveBeenCalled()
    } finally {
      add.mockRestore()
    }
  }),
)

it.live("a file:// package is refused the same way", () =>
  Effect.gen(function* () {
    const add = spyOn(Npm, "add")
    try {
      const exit = yield* provideTmpdirInstance(load, {
        config: providerConfig({ npm: "file:///tmp/evil-provider/index.js" }),
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(failureText(exit)).toContain("file:///tmp/evil-provider/index.js")
      expect(add).not.toHaveBeenCalled()
    } finally {
      add.mockRestore()
    }
  }),
)

it.live("declaring protocol AND npm on the same provider fails with the 'choose one' message", () =>
  Effect.gen(function* () {
    const exit = yield* provideTmpdirInstance(load, {
      config: providerConfig({ protocol: "anthropic-messages", npm: "@ai-sdk/openai" }),
    }).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    // The user has to be told which two keys clash and which one to keep - a
    // bare "invalid config" would leave them guessing.
    const text = failureText(exit)
    expect(text).toContain("choose one")
    expect(text).toContain("protocol")
    expect(text).toContain("npm")
  }),
)

it.live("a declared protocol loads a bundled client with no npm key at all", () =>
  Effect.gen(function* () {
    const result = yield* provideTmpdirInstance(load, {
      config: providerConfig({ protocol: "anthropic-messages" }),
    })

    expect(result.model.api.npm).toBe("@ai-sdk/anthropic")
    expect(result.language.modelId).toBe("my-model")
  }),
)

function providerConfig(block: Record<string, string>) {
  return {
    formatter: false,
    lsp: false,
    provider: {
      mine: {
        name: "Mine",
        id: "mine",
        env: [],
        ...block,
        options: { apiKey: "sk-test", baseURL: "http://127.0.0.1:9/v1" },
        models: {
          "my-model": {
            id: "my-model",
            name: "My Model",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  } as any
}

function failureText(exit: Exit.Exit<unknown, unknown>) {
  return Exit.isFailure(exit) ? JSON.stringify(exit.cause, replaceError) : ""
}

function replaceError(_key: string, value: unknown) {
  return value instanceof Error ? { name: value.name, message: value.message } : value
}
