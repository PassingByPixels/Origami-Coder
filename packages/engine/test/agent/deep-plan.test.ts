// DEEP PLAN's agent definition. The whole mode rests on two facts about this
// record, and neither is visible by reading the natives table casually:
//
//  1. It is a NON-HIDDEN PRIMARY agent, which is the entire ACP wiring. There is
//     no deep-plan branch in acp/service.ts - `modeOptionsFrom` lists exactly the
//     agents matching that shape, so the mode picker gains this one for free and
//     loses it just as silently if either field is ever flipped.
//  2. Its `edit` ruleset is a BOUNDARY, not a grant. Deep plan is for work that
//     may not exist yet, so an agent that could write outside its plan folder
//     would quietly scaffold the project it was asked to think about. Both sides
//     of that boundary are asserted, because a rule that only ever allows is a
//     rule nobody has tested.
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { modeOptionsFrom } from "@/acp/directory"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Skill } from "@/skill"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

/** The action for one permission id against one pattern, as the tools ask it. */
const action = (agent: Agent.Info, permission: string, pattern = "*"): string =>
  Permission.evaluate(permission, pattern, agent.permission).action

/** A path INSIDE the plan folder, in the shape edit/write/apply_patch ask with:
 *  `path.relative(worktree, filepath)`. */
const inPlans = (...parts: string[]) => path.join(".origami", "plans", ...parts)

const FOLDER = "1770000000000-add-a-thing"

afterEach(async () => {
  await disposeAllInstances()
})

describe("the deep-plan agent", () => {
  it.instance("is a primary agent the mode picker will list", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service.use((svc) => svc.get("deep-plan"))
      expect(agent).toBeDefined()
      expect(agent.mode).toBe("primary")
      expect(agent.native).toBe(true)
      // NOT hidden. This is load-bearing: acp/directory.ts `modeOptionsFrom`
      // drops `mode === "subagent"` and native+hidden agents, and offers the
      // rest as session modes.
      expect(agent.hidden).not.toBe(true)
      // Run through the REAL filter, not a copy of it. modeOptionsFrom IS the
      // whole of the ACP wiring for a new mode, so a reproduction of its rule
      // here would go on passing while the shipped picker showed nothing.
      const listed = yield* Agent.Service.use((svc) => svc.list())
      const pickable = modeOptionsFrom(listed).map((option) => option.id)
      expect(pickable).toContain("deep-plan")
      // ...alongside plan, not instead of it.
      expect(pickable).toContain("plan")
      // ...and the picker shows the description, so it must have one.
      expect(modeOptionsFrom(listed).find((option) => option.id === "deep-plan")?.description).toContain("DELIVERS")
    }),
  )

  it.instance("may write inside its plan folder and NOWHERE else", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service.use((svc) => svc.get("deep-plan"))

      // The deliverable is a TREE, not one file: plan mode's glob ends in
      // `*.md`, which would refuse map.json and every research/ file.
      for (const allowed of [
        inPlans(FOLDER, "PLAN.md"),
        inPlans(FOLDER, "DECISIONS.md"),
        inPlans(FOLDER, "map.json"),
        inPlans(FOLDER, "research", "01-streaming.md"),
        inPlans(FOLDER, "research", "critiques", "round-2-failure-modes.md"),
      ]) {
        expect(action(agent, "edit", allowed), `${allowed} should be writable`).toBe("allow")
      }

      // THE BOUNDARY. Deep plan may be asked to plan a project that does not
      // exist yet, and every one of these is a way to start building it instead
      // of planning it.
      for (const denied of [
        "package.json",
        path.join("src", "index.ts"),
        path.join("src", "feature", "new-thing.ts"),
        path.join(".origami", "map", "map.json"),
        path.join(".origami", "memory", "MEMORY.md"),
        path.join("test", "new-thing.test.ts"),
        "README.md",
      ]) {
        expect(action(agent, "edit", denied), `${denied} must NOT be writable`).toBe("deny")
      }
    }),
  )

  it.instance("delegates to explore AND general, and to nothing else", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service.use((svc) => svc.get("deep-plan"))
      // The research fan-out and the three adversarial critics ARE the feature,
      // and `explore` alone cannot read the web or carry a critique brief -
      // which is the one place this differs from plan mode's task rules.
      expect(action(agent, "task", "explore")).toBe("allow")
      expect(action(agent, "task", "general")).toBe("allow")
      // Everything else stays shut, so a "plan" cannot fan out a builder.
      for (const denied of ["build", "deep-plan", "plan", "some-custom-bot"]) {
        expect(action(agent, "task", denied), `task:${denied}`).toBe("deny")
      }
    }),
  )

  it.instance("can ask the user, can end the turn, and can reach the web", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service.use((svc) => svc.get("deep-plan"))
      // Phase 0 batches its interrogation through `question`, and phase 5 hands
      // the folder over through `plan_exit`. Both are DENIED by the shared
      // defaults, so both have to be named by the definition.
      expect(action(agent, "question")).toBe("allow")
      expect(action(agent, "plan_exit")).toBe("allow")
      // The web is open through the `"*": "allow"` base rather than a rule of
      // its own. Asserted anyway: the effective answer is what the research
      // phase depends on, and "it was never denied" is not something a reader
      // of the definition can see.
      expect(action(agent, "websearch")).toBe("allow")
      expect(action(agent, "webfetch")).toBe("allow")
    }),
  )

  it.instance("leaves plan mode exactly as it was", () =>
    Effect.gen(function* () {
      // Deep plan was added BESIDE plan, not on top of it. These are the three
      // rules that would have been easiest to widen by accident while editing
      // the natives table.
      const plan = yield* Agent.Service.use((svc) => svc.get("plan"))
      expect(action(plan, "task", "general")).toBe("deny")
      expect(action(plan, "edit", inPlans(FOLDER, "map.json"))).toBe("deny")
      expect(action(plan, "edit", inPlans("1770000000000-add-a-thing.md"))).toBe("allow")
    }),
  )
})
