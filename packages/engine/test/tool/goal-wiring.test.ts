// Goal mode is inert unless three surfaces are actually WIRED: the tool is in
// the registry, the command is in the vocabulary, and the command does not
// quietly displace a user's own. Every other test in this change assumes those
// and would still pass with all three missing.
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { disposeAllInstances } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Command.node]), [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("goal mode wiring", () => {
  it.instance("offers the goal tool to the default agent", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      expect(yield* registry.ids()).toContain("goal")

      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const goal = tools.find((tool) => tool.id === "goal")
      expect(goal).toBeDefined()
      // The description is the only thing that teaches a model when NOT to set
      // a goal, which is the expensive mistake (a goal costs a model run at
      // every turn end).
      expect(goal!.description).toContain("condition")
    }),
  )

  it.instance("ships /goal in the built-in command vocabulary", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const goal = yield* commands.get("goal")
      expect(goal).toBeDefined()
      expect(goal!.source).toBe("command")
      expect(goal!.hints).toContain("$ARGUMENTS")
      expect(yield* Effect.promise(async () => goal!.template)).toContain("goal")
    }),
  )

  it.instance("does not displace the other built-ins", () =>
    Effect.gen(function* () {
      // `commands` is one flat map; a mis-keyed assignment would overwrite a
      // neighbour rather than add a new entry.
      const commands = yield* Command.Service
      const names = (yield* commands.list()).map((item) => item.name)
      for (const built of ["init", "review", "verify-plan", "dream", "goal"]) expect(names).toContain(built)
    }),
  )
})
