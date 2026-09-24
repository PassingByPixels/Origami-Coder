import { describe, expect } from "bun:test"
import { Directory } from "@/acp/directory"
import { Command } from "@/command"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { Provider } from "@/provider/provider"
import { Effect, Exit, Fiber, Layer } from "effect"
import { it } from "../lib/effect"

const command = (name: string): Command.Info => ({
  name,
  source: "command",
  template: `run ${name}`,
  hints: [],
})

const model = (providerID: ProviderV2.ID, id: string, variants?: Directory.ModelVariants): Provider.Model => ({
  id: ModelV2.ID.make(id),
  providerID,
  api: {
    id,
    url: "https://example.com",
    npm: "@ai-sdk/openai-compatible",
  },
  name: id,
  family: "test",
  capabilities: {
    temperature: true,
    reasoning: Boolean(variants),
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  },
  limit: {
    context: 128000,
    output: 4096,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  ...(variants ? { variants } : {}),
})

const snapshot = (directory: string) => {
  const providerID = ProviderV2.ID.make(`provider-${directory}`)
  const modelID = ModelV2.ID.make(`model-${directory}`)
  const providers = {
    [providerID]: {
      id: providerID,
      name: `Provider ${directory}`,
      source: "config",
      env: [],
      options: {},
      models: {
        [modelID]: model(providerID, modelID, {
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
        }),
        [ModelV2.ID.make(`plain-${directory}`)]: model(providerID, `plain-${directory}`),
      },
    },
  } satisfies Record<ProviderV2.ID, Provider.Info>

  return Directory.build({
    directory,
    providers,
    modes: [
      { id: "build", name: `build-${directory}` },
      { id: "plan", name: `plan-${directory}`, description: "plan first" },
    ],
    defaultModeID: "build",
    commands: [command(`init-${directory}`), command(`review-${directory}`)],
    defaultModel: { providerID, modelID },
  })
}

const fakeLayer = (calls: string[]) =>
  LayerNode.compile(Directory.node, [
    [
      Directory.loaderNode,
      Layer.succeed(
        Directory.Loader,
        Directory.Loader.of({
          load: (directory) =>
            Effect.sync(() => {
              calls.push(directory)
              return snapshot(directory)
            }),
        }),
      ),
    ],
  ])

describe("ACP directory snapshot", () => {
  it.effect("two concurrent callers share one load", () => {
    const calls: string[] = []
    return Effect.gen(function* () {
      const directory = yield* Directory.Service
      const [first, second] = yield* Effect.all([directory.get("alpha"), directory.get("alpha")], {
        concurrency: "unbounded",
      })

      expect(calls).toEqual(["alpha"])
      expect(first).toBe(second)
    }).pipe(Effect.provide(fakeLayer(calls)))
  })

  it.effect("warm calls use cached data", () => {
    const calls: string[] = []
    return Effect.gen(function* () {
      const directory = yield* Directory.Service
      const first = yield* directory.get("alpha")
      const second = yield* directory.get("alpha")

      expect(calls).toEqual(["alpha"])
      expect(first).toBe(second)
    }).pipe(Effect.provide(fakeLayer(calls)))
  })

  it.effect("different directories get different snapshots", () => {
    const calls: string[] = []
    return Effect.gen(function* () {
      const directory = yield* Directory.Service
      const [alpha, beta] = yield* Effect.all([directory.get("alpha"), directory.get("beta")], {
        concurrency: "unbounded",
      })

      expect(calls.toSorted()).toEqual(["alpha", "beta"])
      expect(alpha.directory).toBe("alpha")
      expect(beta.directory).toBe("beta")
      expect(alpha.defaultModel?.providerID).not.toBe(beta.defaultModel?.providerID)
    }).pipe(Effect.provide(fakeLayer(calls)))
  })

  it.effect("model variant lookup works", () =>
    Effect.gen(function* () {
      const directory = yield* Directory.Service
      const alpha = yield* directory.get("alpha")
      const model = alpha.defaultModel!

      expect(directory.variants(alpha, model)).toEqual({
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
      })
      expect(directory.variants(alpha, { ...model, modelID: ModelV2.ID.make("missing") })).toBeUndefined()
    }).pipe(Effect.provide(fakeLayer([]))),
  )

  it.effect("commands and modes are included", () =>
    Effect.gen(function* () {
      const directory = yield* Directory.Service
      const alpha = yield* directory.get("alpha")

      expect(alpha.availableCommands.map((item) => item.name)).toEqual(["init-alpha", "review-alpha"])
      expect(alpha.availableModes).toEqual([
        { id: "build", name: "build-alpha" },
        { id: "plan", name: "plan-alpha", description: "plan first" },
      ])
      expect(alpha.defaultModeID).toBe("build")
    }).pipe(Effect.provide(fakeLayer([]))),
  )

  // t-tc1tnk (scout B#2). The model-switch path puts `refresh` under a 20 s
  // timeout (t-wusuep). The timeout interrupted the shared load, the memo kept
  // the INTERRUPT, and every later prompt or session open in the folder failed
  // with "All fibers interrupted" until the engine restarted.
  const stallingLayer = (calls: string[], stallOn: number) =>
    LayerNode.compile(Directory.node, [
      [
        Directory.loaderNode,
        Layer.succeed(
          Directory.Loader,
          Directory.Loader.of({
            load: (directory) =>
              Effect.suspend(() => {
                calls.push(directory)
                return calls.length === stallOn ? Effect.never : Effect.succeed(snapshot(directory))
              }),
          }),
        ),
      ],
    ])

  it.live("a refresh that times out does not poison later gets", () => {
    const calls: string[] = []
    return Effect.gen(function* () {
      const directory = yield* Directory.Service
      yield* directory.get("alpha")

      const refreshed = yield* Effect.exit(directory.refresh("alpha").pipe(Effect.timeout("20 millis")))
      expect(Exit.isFailure(refreshed)).toBe(true)

      const after = yield* Effect.exit(directory.get("alpha").pipe(Effect.timeout("2 seconds")))
      expect(Exit.isSuccess(after)).toBe(true)
      expect(calls).toEqual(["alpha", "alpha", "alpha"])
    }).pipe(Effect.provide(stallingLayer(calls, 2)))
  })

  it.live("a get waiting on a refresh that times out gets a fresh load", () => {
    const calls: string[] = []
    return Effect.gen(function* () {
      const directory = yield* Directory.Service
      const refresh = yield* Effect.forkChild(Effect.exit(directory.refresh("alpha").pipe(Effect.timeout("50 millis"))))
      yield* Effect.sleep("10 millis")
      const waiting = yield* Effect.forkChild(Effect.exit(directory.get("alpha").pipe(Effect.timeout("2 seconds"))))

      expect(Exit.isFailure(yield* Fiber.join(refresh))).toBe(true)
      const got = yield* Fiber.join(waiting)
      expect(Exit.isSuccess(got)).toBe(true)
      expect(calls).toEqual(["alpha", "alpha"])
    }).pipe(Effect.provide(stallingLayer(calls, 1)))
  })

  it.live("a load that dies is retried by the next get", () => {
    let loads = 0
    const layer = LayerNode.compile(Directory.node, [
      [
        Directory.loaderNode,
        Layer.succeed(
          Directory.Loader,
          Directory.Loader.of({
            load: (directory) =>
              Effect.suspend(() => (++loads === 1 ? Effect.die(new Error("boom")) : Effect.succeed(snapshot(directory)))),
          }),
        ),
      ],
    ])
    return Effect.gen(function* () {
      const directory = yield* Directory.Service
      expect(Exit.hasDies(yield* Effect.exit(directory.get("alpha")))).toBe(true)
      expect((yield* directory.get("alpha")).directory).toBe("alpha")
      expect(loads).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("falls back when the default mode is not available", () =>
    Effect.sync(() => {
      expect(
        Directory.build({
          directory: "alpha",
          providers: {},
          modes: [
            { id: "build", name: "Build" },
            { id: "plan", name: "Plan" },
          ],
          defaultModeID: "hidden",
          commands: [],
        }).defaultModeID,
      ).toBe("build")
    }),
  )
})
