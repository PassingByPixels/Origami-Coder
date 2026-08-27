import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Skill } from "@/skill"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * The acceptance line the loader tests do NOT reach.
 *
 * `loader.test.ts` proves a plugin's SKILL.md files are FOUND. That is not the
 * requirement — the requirement is that they are registered into the session
 * skill list, which is `Skill.all()`. Those are different claims joined by the
 * wiring in `skill/index.ts`, and a test of the first would stay green if the
 * second were deleted.
 */
const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

const FIXTURES = path.resolve(import.meta.dir, "../fixture/agent-plugins")

describe("agent plugin skills reach the session skill list", () => {
  it.live("a lenient plugin's declared skill is returned by Skill.all()", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const list = yield* skill.all()
          const found = list.find((item) => item.name === "qwen-shaped-blender")
          expect(found, `plugin skill missing; got ${list.map((s) => s.name).join(", ")}`).toBeDefined()
          expect(found!.description).toContain("Blender")
          expect(found!.location).toContain(path.join("qwen-shaped", "skill", "SKILL.md"))
          // The body has to arrive too — a registered name with no content would
          // give the model a skill it cannot follow.
          expect(found!.content).toContain("Fixture body")
        }),
      { config: { agentPlugins: [path.join(FIXTURES, "qwen-shaped")] } },
    ),
  )

  it.live("a strict plugin's skills/ layout skill is returned by Skill.all()", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const found = (yield* skill.all()).find((item) => item.name === "standard-mapper")
          expect(found).toBeDefined()
          expect(found!.location).toContain(path.join("standard", "skills", "mapper", "SKILL.md"))
        }),
      { config: { agentPlugins: [path.join(FIXTURES, "standard")] } },
    ),
  )

  it.live("no agentPlugins config contributes no plugin skills", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const names = (yield* skill.all()).map((item) => item.name)
          expect(names).not.toContain("qwen-shaped-blender")
          expect(names).not.toContain("standard-mapper")
        }),
      { config: {} },
    ),
  )
})
