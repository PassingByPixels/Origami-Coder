import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { Global } from "@origami/core/global"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { FSUtil } from "@origami/core/fs-util"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { FlockRouting } from "@/flock/routing"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Effect, Logger } from "effect"
import path from "path"
import {
  disposeAllInstances,
  provideInstanceEffect,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const flockLayer = LayerNode.compile(
  LayerNode.group([
    FlockRouting.node,
    Config.node,
    Provider.node,
    Auth.node,
    Plugin.node,
    RuntimeFlags.node,
    FSUtil.node,
    CrossSpawnSpawner.node,
  ]),
  [[RuntimeFlags.node, RuntimeFlags.layer({})]],
)

const it = testEffect(flockLayer)

afterEach(async () => {
  await disposeAllInstances()
})

// One configured provider, declared through real `provider` config so the models
// travel the same sparse-merge that builds Provider.Model in production
// (provider.ts:1613+) rather than the shape a stub would hand-build.
const PROVIDER: Partial<ConfigV1.Info> = {
  provider: {
    flock: {
      name: "Flock Test",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:9/v1" },
      models: {
        tooler: { name: "Tooler", tool_call: true, cost: { input: 1, output: 3 } },
        spare: { name: "Spare", tool_call: true, cost: { input: 2, output: 9 } },
      },
    },
  },
}

const withProvider = (flock: NonNullable<ConfigV1.Info["flock"]>): Partial<ConfigV1.Info> => ({ ...PROVIDER, flock })

const captureLogs = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lines: string[] = []
    const logger = Logger.make<unknown, void>((options) => {
      lines.push(JSON.stringify(options.message))
    })
    const value = yield* self.pipe(Effect.provide(Logger.layer([logger])))
    return { value, lines }
  })

const codes = (issues: FlockRouting.Issue[]) => issues.map((issue) => issue.code)

// Expected bindings, branded the way the service returns them. Built from the
// two halves rather than from a "provider/model" string so the expectation does
// not lean on the very splitting the tests are checking.
const binding = (providerID: string, modelID: string): FlockRouting.Binding => ({
  providerID: ProviderV2.ID.make(providerID),
  modelID: ModelV2.ID.make(modelID),
})

describe("FlockRouting.active", () => {
  it.instance("is off when the config has no flock section at all", () =>
    Effect.gen(function* () {
      expect(yield* FlockRouting.use.active()).toBeUndefined()
    }),
  )

  it.instance(
    "is off when profiles exist but none is selected",
    () =>
      Effect.gen(function* () {
        expect(yield* FlockRouting.use.active()).toBeUndefined()
      }),
    { config: { flock: { profiles: { "local-first": { subagents: { use: "flock/tooler" } } } } } },
  )

  it.instance(
    "is off when the selected profile is explicitly null",
    () =>
      Effect.gen(function* () {
        expect(yield* FlockRouting.use.active()).toBeUndefined()
      }),
    {
      config: { flock: { profile: null, profiles: { "local-first": { subagents: { use: "flock/tooler" } } } } },
    },
  )

  it.instance(
    "is off, and says so once, when the selected profile does not exist",
    () =>
      Effect.gen(function* () {
        const { value, lines } = yield* captureLogs(
          Effect.gen(function* () {
            const first = yield* FlockRouting.use.active()
            const second = yield* FlockRouting.use.active()
            return [first, second]
          }),
        )
        expect(value).toEqual([undefined, undefined])
        const warnings = lines.filter((line) => line.includes("flock profile not found"))
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("typo-first")
      }),
    { config: { flock: { profile: "typo-first", profiles: { "local-first": {} } } } },
  )

  it.instance(
    "is off when the selected name only matches an Object prototype member",
    () =>
      Effect.gen(function* () {
        // `profiles` is a plain decoded object, so a naive lookup answers
        // "toString" with a function and the toggle would claim Flock is on.
        expect(yield* FlockRouting.use.active()).toBeUndefined()
        expect(yield* FlockRouting.use.resolveSubagents()).toBeUndefined()
      }),
    { config: { flock: { profile: "toString", profiles: { "local-first": { subagents: { use: "a/b" } } } } } },
  )

  it.instance(
    "is on when the selected profile exists",
    () =>
      Effect.gen(function* () {
        const active = yield* FlockRouting.use.active()
        expect(active?.name).toBe("local-first")
        expect(active?.profile.subagents?.use).toBe("flock/tooler")
      }),
    {
      config: {
        flock: { profile: "local-first", profiles: { "local-first": { subagents: { use: "flock/tooler" } } } },
      },
    },
  )
})

describe("FlockRouting.resolveSubagents", () => {
  it.instance(
    "returns the primary binding followed by each fallback, in order",
    () =>
      Effect.gen(function* () {
        expect(yield* FlockRouting.use.resolveSubagents()).toEqual([
          binding("spark", "laguna"),
          binding("lmstudio", "qwen-32b"),
          binding("anthropic", "claude-2"),
        ])
      }),
    {
      config: {
        flock: {
          profile: "p",
          profiles: {
            p: { subagents: { use: "spark/laguna", fallback: ["lmstudio/qwen-32b", "anthropic/claude-2"] } },
          },
        },
      },
    },
  )

  it.instance(
    "keeps slashes inside the model id, like the engine's own provider/model parsing",
    () =>
      Effect.gen(function* () {
        expect(yield* FlockRouting.use.resolveSubagents()).toEqual([binding("openrouter", "openai/gpt-5.5")])
      }),
    { config: { flock: { profile: "p", profiles: { p: { subagents: { use: "openrouter/openai/gpt-5.5" } } } } } },
  )

  it.instance(
    "has no opinion when Flock is off, even though the profile binds a model",
    () =>
      Effect.gen(function* () {
        expect(yield* FlockRouting.use.resolveSubagents()).toBeUndefined()
      }),
    { config: { flock: { profiles: { p: { subagents: { use: "spark/laguna" } } } } } },
  )

  it.instance(
    "has no opinion when the active profile binds no subagent model",
    () =>
      Effect.gen(function* () {
        // D10: no binding is not an error, it is silence. The task tool then runs
        // the child on the session's own model, exactly as with Flock off.
        expect(yield* FlockRouting.use.resolveSubagents()).toBeUndefined()
      }),
    { config: { flock: { profile: "p", profiles: { p: { description: "binds nothing" } } } } },
  )

  it.instance(
    "skips a malformed entry and keeps the usable ones",
    () =>
      Effect.gen(function* () {
        const { value, lines } = yield* captureLogs(FlockRouting.use.resolveSubagents())
        expect(value).toEqual([binding("spark", "laguna")])
        expect(lines.filter((line) => line.includes("not in provider/model form"))).toHaveLength(2)
      }),
    {
      config: {
        flock: {
          profile: "p",
          profiles: { p: { subagents: { use: "laguna", fallback: ["spark/laguna", "trailing/"] } } },
        },
      },
    },
  )

  it.instance(
    "has no opinion when every entry in the chain is malformed",
    () =>
      Effect.gen(function* () {
        expect(yield* FlockRouting.use.resolveSubagents()).toBeUndefined()
      }),
    {
      config: {
        flock: { profile: "p", profiles: { p: { subagents: { use: "laguna", fallback: ["", "/orphan"] } } } },
      },
    },
  )
})

describe("FlockRouting.resolveSubagents — old profile shape", () => {
  it.instance(
    "routes an old slot-shaped profile through its executor binding",
    () =>
      Effect.gen(function* () {
        // The pre-E1 shape bound four slots and a role table. `executor` was the
        // trusted slot — plan, execute, repair, judge — so it is the honest
        // single answer to "which model did this user trust with real work".
        expect(yield* FlockRouting.use.resolveSubagents()).toEqual([
          binding("spark", "laguna"),
          binding("lmstudio", "qwen-32b"),
        ])
      }),
    {
      config: {
        flock: {
          profile: "p",
          profiles: {
            p: {
              executor: { use: "spark/laguna", fallback: ["lmstudio/qwen-32b"], fanout: 4, escalate: "a/b" },
              scout: { use: "ignored/scout" },
              workhorse: { use: "ignored/workhorse" },
              roles: { read: { use: "ignored/read" } },
            },
          },
        },
      },
    },
  )

  it.instance(
    "says once that the old shape was migrated, and does not repeat itself",
    () =>
      Effect.gen(function* () {
        const { lines } = yield* captureLogs(
          Effect.gen(function* () {
            yield* FlockRouting.use.resolveSubagents()
            yield* FlockRouting.use.resolveSubagents()
          }),
        )
        const notices = lines.filter((line) => line.includes("old routing shape"))
        // Told ONCE, not never: the other half of that profile now routes
        // nothing, and a user who is not told reads the surviving half as proof
        // the whole file still works.
        expect(notices).toHaveLength(1)
        expect(notices[0]).toContain("spark/laguna")
      }),
    {
      config: {
        flock: {
          profile: "p",
          profiles: { p: { executor: { use: "spark/laguna" }, workhorse: { use: "ignored/workhorse" } } },
        },
      },
    },
  )

  it.instance(
    "binds nothing for an old profile that never named an executor, and warns that it now routes nothing",
    () =>
      Effect.gen(function* () {
        // scout/workhorse/roles are read and dropped. A profile that only ever
        // bound those falls through to the session's model rather than picking
        // one of them at random — and its owner is the one who most needs
        // telling, because everything else still says the profile is active.
        const { value, lines } = yield* captureLogs(
          Effect.gen(function* () {
            const first = yield* FlockRouting.use.resolveSubagents()
            const second = yield* FlockRouting.use.resolveSubagents()
            return [first, second]
          }),
        )
        expect(value).toEqual([undefined, undefined])
        const warnings = lines.filter((line) => line.includes("routes nothing"))
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("p")
      }),
    {
      config: {
        flock: {
          profile: "p",
          profiles: { p: { scout: { use: "flock/tooler" }, roles: { compact: { use: "flock/spare" } } } },
        },
      },
    },
  )

  it.instance(
    "says nothing about the old shape for a profile that never used it",
    () =>
      Effect.gen(function* () {
        const { lines } = yield* captureLogs(FlockRouting.use.resolveSubagents())
        expect(lines.filter((line) => line.includes("old routing shape"))).toHaveLength(0)
      }),
    { config: { flock: { profile: "p", profiles: { p: { description: "binds nothing, and never did" } } } } },
  )

  it.instance(
    "prefers an explicit subagents binding over a legacy executor beside it",
    () =>
      Effect.gen(function* () {
        const { value, lines } = yield* captureLogs(FlockRouting.use.resolveSubagents())
        expect(value).toEqual([binding("spark", "laguna")])
        // Nothing was migrated, so nothing is announced.
        expect(lines.filter((line) => line.includes("old routing shape"))).toHaveLength(0)
      }),
    {
      config: {
        flock: {
          profile: "p",
          profiles: { p: { subagents: { use: "spark/laguna" }, executor: { use: "stale/executor" } } },
        },
      },
    },
  )
})

describe("FlockRouting.resolveSubagents config layering", () => {
  const GLOBAL = {
    flock: {
      profile: "shared",
      profiles: {
        shared: { description: "from global", subagents: { use: "global/worker" } },
        "global-only": { subagents: { use: "global/other" } },
      },
    },
  }

  const PROJECT = {
    flock: { profiles: { shared: { subagents: { use: "project/worker" } } } },
  }

  const withLayeredConfig = <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const globalDir = yield* tmpdirScoped()
      const projectDir = yield* tmpdirScoped({ config: PROJECT })
      yield* FSUtil.use.writeWithDirs(
        path.join(globalDir, "origami.json"),
        JSON.stringify({ ...GLOBAL }),
      )
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = globalDir
      yield* Config.use.invalidate()
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          ;(Global.Path as { config: string }).config = previous
          yield* Config.use.invalidate()
        }).pipe(Effect.orDie),
      )
      return yield* self.pipe(
        Effect.provideService(TestInstance, { directory: projectDir }),
        provideInstanceEffect(projectDir),
      )
    }).pipe(Effect.provide(testInstanceStoreLayer))

  it.live("resolves the binding the project layer overrides to the project's model", () =>
    withLayeredConfig(
      Effect.gen(function* () {
        expect(yield* FlockRouting.use.resolveSubagents()).toEqual([binding("project", "worker")])
      }),
    ),
  )

  it.live("keeps a profile only the global layer defines", () =>
    withLayeredConfig(
      Effect.gen(function* () {
        // A shallow merge of the flock section would replace `profiles` wholesale
        // and drop this one entirely — which validate would then report as
        // `unknown_profile`. Anything else means the merge kept it.
        expect(codes((yield* FlockRouting.use.validate("global-only")).errors)).toEqual([])
      }),
    ),
  )

  it.live("takes the active profile name from the global layer when the project omits it", () =>
    withLayeredConfig(
      Effect.gen(function* () {
        expect((yield* FlockRouting.use.active())?.name).toBe("shared")
      }),
    ),
  )
})

describe("FlockRouting.validate", () => {
  it.instance(
    "reports a profile that is not defined",
    () =>
      Effect.gen(function* () {
        const report = yield* FlockRouting.use.validate("nope")
        expect(codes(report.errors)).toEqual(["unknown_profile"])
        expect(report.errors[0].message).toContain("nope")
        // A clean report for a profile that is not there would read as a
        // green light for a name that routes nothing.
        expect(codes((yield* FlockRouting.use.validate("constructor")).errors)).toEqual(["unknown_profile"])
      }),
    { config: withProvider({ profiles: { p: { subagents: { use: "flock/tooler" } } } }) },
  )

  it.instance(
    "reports nothing for a profile whose whole chain resolves",
    () =>
      Effect.gen(function* () {
        const report = yield* FlockRouting.use.validate("p")
        expect(report).toEqual({ errors: [], warnings: [] })
      }),
    { config: withProvider({ profiles: { p: { subagents: { use: "flock/tooler", fallback: ["flock/spare"] } } } }) },
  )

  it.instance(
    "reports nothing for a profile that binds no subagent model",
    () =>
      Effect.gen(function* () {
        // Binding nothing is a valid profile — it just routes nothing. Warning
        // about it would nag every user who only wants a description.
        expect(yield* FlockRouting.use.validate("p")).toEqual({ errors: [], warnings: [] })
      }),
    { config: withProvider({ profiles: { p: { description: "binds nothing" } } }) },
  )

  it.instance(
    "warns about a binding that is not in provider/model form",
    () =>
      Effect.gen(function* () {
        const report = yield* FlockRouting.use.validate("p")
        expect(codes(report.warnings)).toEqual(["malformed_binding"])
        expect(report.warnings[0].message).toContain("justamodelname")
        expect(report.errors).toEqual([])
      }),
    { config: withProvider({ profiles: { p: { subagents: { use: "justamodelname" } } } }) },
  )

  it.instance(
    "warns about a binding no provider can supply",
    () =>
      Effect.gen(function* () {
        const report = yield* FlockRouting.use.validate("p")
        expect(codes(report.warnings)).toEqual(["unknown_binding"])
        expect(report.warnings[0].message).toContain("ghost/model")
        expect(report.errors).toEqual([])
      }),
    { config: withProvider({ profiles: { p: { subagents: { use: "ghost/model" } } } }) },
  )

  it.instance(
    "checks every binding in the chain, not only the primary",
    () =>
      Effect.gen(function* () {
        const report = yield* FlockRouting.use.validate("p")
        // A fallback nobody can supply is exactly the one that bites, because it
        // only ever runs once the primary is already down.
        expect(codes(report.warnings)).toEqual(["unknown_binding"])
        expect(report.warnings[0].message).toContain("flock/absent")
      }),
    { config: withProvider({ profiles: { p: { subagents: { use: "flock/tooler", fallback: ["flock/absent"] } } } }) },
  )

  it.instance(
    "validates an old slot-shaped profile through the binding it now routes on",
    () =>
      Effect.gen(function* () {
        const report = yield* FlockRouting.use.validate("p")
        // The `scout` slot is broken and says nothing, because it no longer
        // routes anything. Reporting it would send the user to fix a dead key.
        expect(codes(report.warnings)).toEqual(["unknown_binding"])
        expect(report.warnings[0].message).toContain("ghost/model")
      }),
    {
      config: withProvider({
        profiles: { p: { executor: { use: "ghost/model" }, scout: { use: "alsoghost/model" } } },
      }),
    },
  )
})
