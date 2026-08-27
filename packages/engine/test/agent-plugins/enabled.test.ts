import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { AgentPlugins } from "@/agent-plugins"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * The regression risk in the config schema change (t-kgtolm round 3): a
 * disabled plugin has to be resolved and parsed (the Plugins pane needs its
 * name/version/skills/mcp to show a card), but NEVER reach the live
 * session's skill/tool wiring, because "disabled" is the entire point.
 * `Skill.Service` proves the wiring at one more remove
 * (skill-registration.test.ts); this proves `AgentPlugins.Service` itself,
 * which is where the enabled/disabled split actually happens.
 */

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(AgentPlugins.node),
    LayerNode.compile(CrossSpawnSpawner.node),
    testInstanceStoreLayer,
  ),
)

const FIXTURES = path.resolve(import.meta.dir, "../fixture/agent-plugins")

describe("AgentPlugins.Service — enabled vs disabled", () => {
  it.live("a disabled plugin is listed for display but contributes no skills or mcp servers", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const plugins = yield* AgentPlugins.Service
          const all = yield* plugins.all()
          const found = all.find((item) => item.name === "standard.fixture")
          expect(found, `plugin missing; got ${all.map((p) => p.name).join(", ")}`).toBeDefined()
          expect(found!.enabled).toBe(false)
          // Still fully resolved for the card, not just the bare spec.
          expect(found!.mode).toBe("strict")
          expect(Object.keys(found!.mcp).toSorted()).toEqual(["standard-local", "standard-remote"])
          expect(found!.skillFiles).toHaveLength(1)

          // But none of it reaches the live session.
          expect(yield* plugins.skillFiles()).toEqual([])
          expect(yield* plugins.mcpServers()).toEqual({})
          expect(yield* plugins.owner("standard-local")).toBeUndefined()
        }),
      { config: { agentPlugins: [{ spec: path.join(FIXTURES, "standard"), enabled: false }] } },
    ),
  )

  it.live("an enabled plugin (plain string entry) DOES reach skillFiles/mcpServers", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const plugins = yield* AgentPlugins.Service
          const found = (yield* plugins.all()).find((item) => item.name === "standard.fixture")
          expect(found!.enabled).toBe(true)

          const skillFiles = yield* plugins.skillFiles()
          expect(skillFiles.some((f) => f.endsWith(path.join("skills", "mapper", "SKILL.md")))).toBe(true)
          const servers = yield* plugins.mcpServers()
          expect(Object.keys(servers).toSorted()).toEqual(["standard-local", "standard-remote"])
          expect(yield* plugins.owner("standard-local")).toBe("standard.fixture")
        }),
      { config: { agentPlugins: [path.join(FIXTURES, "standard")] } },
    ),
  )

  it.live("enabled defaults true for an object-form entry that omits it", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const plugins = yield* AgentPlugins.Service
          const found = (yield* plugins.all()).find((item) => item.name === "standard.fixture")
          expect(found!.enabled).toBe(true)
          expect(yield* plugins.mcpServers()).not.toEqual({})
        }),
      { config: { agentPlugins: [{ spec: path.join(FIXTURES, "standard") }] } },
    ),
  )
})
