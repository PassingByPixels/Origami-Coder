// The collab turn's RUNAWAY BACKSTOP.
//
// A collab turn is unattended in a way an ordinary chat is not: its reply fans
// out to every other participant, so a turn that never terminates does not just
// burn tokens, it keeps waking the room. The engine's own ceiling is
// DEFAULT_MAX_STEPS = 500 (src/session/prompt.ts) - a number chosen for an
// attended chat with a Stop button.
//
// WHERE THE CAP IS SET, and why here. src/session/prompt.ts computes
// `const maxSteps = agent.steps ?? DEFAULT_MAX_STEPS` from the Agent.Info it
// resolves for the message's agent, and hard-breaks the loop on
// `step > maxSteps`. The collab runner drives a turn through
// `SessionPrompt.prompt({ sessionID, agent: <slug> })` (src/collab/runner.ts),
// so the agent it names is the collab agent, and that agent's own `steps:`
// frontmatter is what the guard reads. No wiring at the runner's prompt call is
// needed, and none was added - a second cap there would be a number that
// disagrees with the def and wins silently.
//
// So the whole mechanism is: def frontmatter -> Agent.Info.steps -> the guard.
// The guard end is already proven against the REAL loop in
// test/session/prompt.test.ts ("loop hard-stops at the step budget instead of
// looping forever", which drives a config agent with steps=2 and asserts the
// model is called exactly twice). What was NOT covered is the first arrow: that
// a def file shaped like a COLLAB agent def carries its budget through the
// config loader into Agent.Info at all. That is what this file pins - against
// the real Agent service reading a real file on disk, because the failure it
// guards against is a schema that quietly sweeps `steps` into `options` where
// nothing reads it.

import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { LayerNode } from "@origami/core/effect/layer-node"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

/** The budgets the extension writes into a WORKER and an OBSERVER def. Restated
 *  rather than imported: packages/vscode is a separate build, and this test's
 *  job is the engine's half of the contract. */
const WORKER_STEPS = 40
const OBSERVER_STEPS = 25

/** A collab agent def in exactly the form the seed installer and the CRUD pane
 *  write it - `collab: true`, hidden, and a deny-by-default permission block
 *  under the scalar keys. The block matters: `steps` is read out of the same
 *  frontmatter, and a reader that stopped at the first nested key would miss it
 *  depending on the order. */
const def = (steps?: number) =>
  [
    "---",
    'description: "probe - a collab agent def"',
    "mode: all",
    "hidden: true",
    "collab: true",
    ...(steps === undefined ? [] : [`steps: ${steps}`]),
    "permission:",
    '  "*": deny',
    "  read: allow",
    "  grep: allow",
    "  glob: allow",
    "  list: allow",
    "  edit: allow",
    "  bash: allow",
    "  task: deny",
    "  todowrite: deny",
    "---",
    "",
    "You are a probe.",
    "",
  ].join("\n")

const writeDefs = (directory: string) =>
  Effect.promise(async () => {
    const dir = path.join(directory, ".origami", "agent")
    await Bun.write(path.join(dir, "collab-worker-probe.md"), def(WORKER_STEPS))
    await Bun.write(path.join(dir, "collab-observer-probe.md"), def(OBSERVER_STEPS))
    await Bun.write(path.join(dir, "collab-uncapped-probe.md"), def())
  })

afterEach(async () => {
  await disposeAllInstances()
})

describe("a collab agent def's step budget", () => {
  it.instance(
    "reaches Agent.Info.steps, which is the value session/prompt.ts caps the loop with",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        expect((yield* agents.get("collab-worker-probe")).steps).toBe(WORKER_STEPS)
        expect((yield* agents.get("collab-observer-probe")).steps).toBe(OBSERVER_STEPS)
      }),
    { init: writeDefs },
  )

  it.instance(
    "is UNSET when the def omits it - which is the 500-step chat default the presets exist to replace",
    () =>
      Effect.gen(function* () {
        // The negative half. Without it, a `steps` that never arrived would be
        // indistinguishable from one that did, if some default happened to equal
        // the number under test.
        const uncapped = yield* Agent.Service.use((svc) => svc.get("collab-uncapped-probe"))
        expect(uncapped.steps).toBeUndefined()
      }),
    { init: writeDefs },
  )

  it.instance(
    "survives the frontmatter around it - the def still parses as a hidden collab agent",
    () =>
      Effect.gen(function* () {
        // A `steps:` line that broke the sweep of unknown keys into `options`
        // would take `collab: true` with it, and the agent would vanish from the
        // collab lane with the cap still looking correct here.
        const worker = yield* Agent.Service.use((svc) => svc.get("collab-worker-probe"))
        expect(worker.options["collab"]).toBe(true)
        expect(worker.hidden).toBe(true)
        expect(worker.mode).toBe("all")
      }),
    { init: writeDefs },
  )
})
