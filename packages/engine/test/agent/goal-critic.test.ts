// The critic agent's PERMISSIONS are the load-bearing part of goal mode's
// honesty, and the owner has drawn the line in a new place: the critic WRITES
// TO VALIDATE. It may create the test that does not exist yet, because a
// condition whose only honest check is a missing test cannot be verified by
// reading. What it may never do is delegate the judgement (`task`) or lobby
// anyone about it (`send_message`) - those two are asserted here in BOTH the
// definition and the spawn shape, because a parent chat's auto-approve preset
// must not re-open them.
//
// The "never fix the project" half of the contract lives in the PROMPT, not in
// the ruleset - a path glob cannot tell a newly written test from an existing
// one edited until it passes. So the prompt's load-bearing clauses are asserted
// too: drop them and the permission this file widened has nothing holding it.
//
// It also has to be HIDDEN and it has to have `bash`, and those two pull in
// opposite directions, so both are asserted here rather than left to a reading
// of the definition.
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { PermissionV1 } from "@origami/core/v1/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Skill } from "@/skill"
import { SessionGoal } from "@/session/goal"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

const action = (agent: Agent.Info, permission: string): PermissionV1.Action =>
  Permission.evaluate(permission, "*", agent.permission).action

afterEach(async () => {
  await disposeAllInstances()
})

describe("the goal-critic agent", () => {
  it.instance("is registered as a hidden subagent", () =>
    Effect.gen(function* () {
      const critic = yield* Agent.Service.use((svc) => svc.get(SessionGoal.CRITIC_AGENT))
      expect(critic).toBeDefined()
      expect(critic.mode).toBe("subagent")
      expect(critic.hidden).toBe(true)
      // Hidden means the MODEL cannot reach for it by name. A critic the agent
      // under review can invoke - with the transcript in hand - is not a critic.
      const listed = yield* Agent.Service.use((svc) => svc.list())
      expect(listed.filter((item) => !item.hidden).map((item) => item.name)).not.toContain(SessionGoal.CRITIC_AGENT)
    }),
  )

  it.instance("can gather evidence, and can write to validate", () =>
    Effect.gen(function* () {
      const critic = yield* Agent.Service.use((svc) => svc.get(SessionGoal.CRITIC_AGENT))
      // It must be able to gather its OWN evidence, which is why bash is here:
      // "the tests pass" cannot be verified by reading files. `edit` is the ONE
      // id `edit`, `write` and `apply_patch` all ask under (Permission.disabled
      // states that mapping), so a single allow is what lets a missing test be
      // written - and what keeps all three tools in the roster rather than
      // hidden by the `"*": "deny"` base.
      for (const allowed of ["read", "grep", "glob", "list", "bash", "git_diff", "edit"]) {
        expect(action(critic, allowed)).toBe("allow")
      }
      // A writable critic must still not delegate the call or lobby anyone
      // about it - those are the two no reviewer may have.
      for (const denied of ["task", "send_message", "todowrite", "goal"]) {
        expect(action(critic, denied)).toBe("deny")
      }
    }),
  )

  it.instance("keeps the write-to-validate contract in the prompt, where the ruleset cannot state it", () =>
    Effect.gen(function* () {
      // The ruleset says "may write". Only the prompt says "may write ONLY to
      // validate", and that is not a gap - a path glob cannot tell a newly
      // written test from an existing one edited until it passes. These clauses
      // ARE the guard the widened permission leans on.
      const critic = yield* Agent.Service.use((svc) => svc.get(SessionGoal.CRITIC_AGENT))
      const prompt = critic.prompt ?? ""
      expect(prompt).toContain("You may WRITE, but only to VALIDATE")
      // Never repair the work under review...
      expect(prompt).toContain("you never make it met")
      // ...never soften an existing check into a pass...
      expect(prompt).toContain("A test you had to change is a NOT MET")
      // ...and disclose every write, because an undisclosed one reads exactly
      // like tampering.
      expect(prompt).toContain("Name EVERY file you created or changed")
      // The old blanket claim must be GONE. A prompt still saying "strictly
      // read-only" over a ruleset that allows edits is worse than either rule
      // alone: the model would have to pick which one to believe.
      expect(prompt).not.toContain("strictly read-only")
    }),
  )

  it.instance("cannot delegate or lobby even when the parent chat is on bypass", () =>
    Effect.gen(function* () {
      // FOUND BY THIS TEST. `deriveSubagentSessionPermission` deliberately
      // carries a parent's auto-approve PRESET down to its children, so a chat
      // on YOLO handed the critic `"*": "allow"` - and, while the critic was
      // read-only, an editor with it. The spawn re-appends the agent's own
      // ruleset last, which `Permission.evaluate` (findLast) lets win.
      //
      // WIDENING THE CRITIC MOVED THIS TEST'S SUBJECT rather than retiring it.
      // `edit` is now the definition's own decision, so a preset granting it
      // grants nothing new, and asserting it would prove nothing.
      //
      // What the reassertion still buys is everything the derive does NOT close
      // by itself. The derive appends exactly four denies (todowrite, task,
      // send_message, list_agents) and passes the preset through untouched - so
      // under bypass EVERY other tool the definition denied comes back.
      // `file_delete` is the sharpest of them: a recursive delete is how a
      // critic destroys the evidence it was spawned to gather. `question` is
      // how a BLIND verifier stops being blind.
      const critic = yield* Agent.Service.use((svc) => svc.get(SessionGoal.CRITIC_AGENT))
      const bypassed: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]

      // The shape the spawn actually uses.
      const spawned = SessionGoal.criticPermission({ parentSessionPermission: bypassed, critic })
      for (const denied of ["task", "send_message", "todowrite", "goal", "file_delete", "question"]) {
        expect(Permission.evaluate(denied, "*", Permission.merge(critic.permission, spawned)).action).toBe("deny")
      }
      // ...and it is still allowed to gather evidence, and to write its probe.
      for (const allowed of ["read", "grep", "bash", "edit"]) {
        expect(Permission.evaluate(allowed, "*", Permission.merge(critic.permission, spawned)).action).toBe("allow")
      }

      // The bare derive is NOT enough - these are the lines that would go green
      // if the reassertion were dropped, and they are why `criticPermission`
      // exists. `task` is deliberately NOT one of them: the derive denies it
      // itself, so it could never have carried this proof.
      const bare = deriveSubagentSessionPermission({ parentSessionPermission: bypassed, subagent: critic })
      expect(Permission.evaluate("file_delete", "*", Permission.merge(critic.permission, bare)).action).toBe("allow")
      expect(Permission.evaluate("question", "*", Permission.merge(critic.permission, bare)).action).toBe("allow")
    }),
  )

  it.instance("carries a step cap, so a verification cannot become a second implementation", () =>
    Effect.gen(function* () {
      const critic = yield* Agent.Service.use((svc) => svc.get(SessionGoal.CRITIC_AGENT))
      expect(critic.steps).toBeGreaterThan(0)
      expect(critic.steps).toBeLessThanOrEqual(20)
    }),
  )

  it.instance("is briefed to end on a line the engine can actually parse", () =>
    Effect.gen(function* () {
      // The verdict line is the entire machine-readable output of this agent.
      // A prompt that drifted from the parser would make every run an error.
      const critic = yield* Agent.Service.use((svc) => svc.get(SessionGoal.CRITIC_AGENT))
      expect(critic.prompt).toBeDefined()
      expect(SessionGoal.parseVerdict(critic.prompt!.split(SessionGoal.VERDICT_MET)[0] + SessionGoal.VERDICT_MET)).toBe(
        "met",
      )
      expect(critic.prompt).toContain(SessionGoal.VERDICT_NOT_MET)
    }),
  )
})
