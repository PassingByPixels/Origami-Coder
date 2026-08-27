import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { SystemPrompt } from "@/session/system"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(SystemPrompt.node))

afterEach(async () => {
  await disposeAllInstances()
})

// FLOCK_SPEC §5, transcribed. This is shipping copy that goes into the main
// agent's system prompt verbatim — a diff here is a product change, not a
// reword. Note what it does NOT say: no roles, no models, no prices (D8).
const DELEGATION =
  `If you can state what "done" looks like and you don't need to witness the steps, ` +
  `delegate it — you keep the result, and your context stays on the goal itself. ` +
  `Hand out the groundwork: reading, locating, transforming, verifying, ` +
  `researching. Your context is the scarce resource; spend it on the goal, not the ` +
  `groundwork.`

const agent = (name: string, mode: Agent.Info["mode"]): Agent.Info => ({
  name,
  mode,
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
})

const FLOCK = { flock: { profile: "p", profiles: { p: { subagents: { use: "flock/tooler" } } } } }

describe("flock system prompt (§5)", () => {
  it.instance(
    "gives a primary agent the delegation paragraph while a profile is active",
    () =>
      Effect.gen(function* () {
        expect(yield* (yield* SystemPrompt.Service).flock(agent("build", "primary"))).toBe(DELEGATION)
      }),
    { config: FLOCK },
  )

  it.instance("says nothing when no profile is active", () =>
    Effect.gen(function* () {
      expect(yield* (yield* SystemPrompt.Service).flock(agent("build", "primary"))).toBeUndefined()
    }),
  )

  it.instance(
    "says nothing when a profile exists but none is selected",
    () =>
      Effect.gen(function* () {
        expect(yield* (yield* SystemPrompt.Service).flock(agent("build", "primary"))).toBeUndefined()
      }),
    { config: { flock: { profiles: { p: { subagents: { use: "flock/tooler" } } } } } },
  )

  it.instance(
    "gives the paragraph on a profile still written in the old slot shape",
    () =>
      Effect.gen(function* () {
        // Read-compat reaches the prompt too: a user who never rewrites their
        // config keeps the behaviour they had.
        expect(yield* (yield* SystemPrompt.Service).flock(agent("build", "primary"))).toBe(DELEGATION)
      }),
    { config: { flock: { profile: "p", profiles: { p: { executor: { use: "flock/tooler" } } } } } },
  )

  it.instance(
    "says nothing to a subagent, which cannot delegate anyway",
    () =>
      Effect.gen(function* () {
        // The task tool is denied to subagents (task.ts childToolDenies), so
        // delegation copy in their context is pure noise.
        const sys = yield* SystemPrompt.Service
        expect(yield* sys.flock(agent("explore", "subagent"))).toBeUndefined()
        expect(yield* sys.flock(agent("reviewer", "all"))).toBeUndefined()
      }),
    { config: FLOCK },
  )
})
