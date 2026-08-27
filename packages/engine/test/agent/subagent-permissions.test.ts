import { PermissionV1 } from "@origami/core/v1/permission"
import { describe, test, expect } from "bun:test"
import type { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"

// What crosses the parent -> subagent boundary, rule by rule. The helper has to
// hold two opposing intents at once:
//   - an ALLOW the parent agent happens to have is not the child's to inherit
//     (upstream's safety rule: the child's own agent decides what it may do), and
//   - the user's live auto-approve PRESET is not an agent capability at all - it
//     is the answer "stop asking me, in this chat" - so it must reach the child
//     or YOLO silently stops at the first `task` call.
// The trio below pins both halves plus the unchanged deny/external_directory path.
//
// See also test/agent/plan-mode-subagent-bypass.test.ts, which covers the same
// helper from the AGENT side (subagent capabilities vs parent agent restrictions).

const worker = (permission: PermissionV1.Ruleset = []): Agent.Info => ({
  name: "worker",
  mode: "subagent",
  permission: [...permission],
  options: {},
})

const BYPASS: PermissionV1.Rule = { permission: "*", pattern: "*", action: "allow" }
const AUTO: PermissionV1.Rule = { permission: "edit", pattern: "*", action: "allow" }

const derive = (parentSessionPermission: PermissionV1.Ruleset, subagent = worker()) =>
  deriveSubagentSessionPermission({ parentSessionPermission, subagent })

describe("deriveSubagentSessionPermission", () => {
  test("an ordinary session allow does NOT reach the subagent", () => {
    const derived = derive([
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "webfetch", pattern: "https://example.com/*", action: "allow" },
      // Same permission key as the "auto" preset, but a NARROWED pattern, so it
      // is a configured allow rather than the preset marker.
      { permission: "edit", pattern: "src/**", action: "allow" },
    ])

    expect(derived).not.toContainEqual({ permission: "bash", pattern: "*", action: "allow" })
    expect(derived).not.toContainEqual({ permission: "webfetch", pattern: "https://example.com/*", action: "allow" })
    expect(derived).not.toContainEqual({ permission: "edit", pattern: "src/**", action: "allow" })
    // ...and the child still asks for the thing the parent had been allowed.
    expect(Permission.evaluate("bash", "git status", derived).action).toBe("ask")
  })

  test("deny rules and external_directory rules still reach the subagent", () => {
    const denyBash: PermissionV1.Rule = { permission: "bash", pattern: "*", action: "deny" }
    const externalAllow: PermissionV1.Rule = {
      permission: "external_directory",
      pattern: "/tmp/allowed/*",
      action: "allow",
    }
    const externalAsk: PermissionV1.Rule = { permission: "external_directory", pattern: "*", action: "ask" }

    // Order matches Permission.fromConfig({ external_directory: { "*": "ask",
    // "/tmp/allowed/*": "allow" } }): the broad ask first, the specific allow
    // after it, because evaluate() takes the LAST match.
    const derived = derive([denyBash, externalAsk, externalAllow])

    expect(derived).toContainEqual(denyBash)
    expect(derived).toContainEqual(externalAllow)
    expect(derived).toContainEqual(externalAsk)
    expect(Permission.evaluate("bash", "git status", derived).action).toBe("deny")
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", derived).action).toBe("allow")
  })

  test("the bypass wildcard and the auto marker DO reach the subagent", () => {
    expect(derive([BYPASS])).toContainEqual(BYPASS)
    expect(derive([AUTO])).toContainEqual(AUTO)

    // The rule that matters is the EFFECTIVE one the child's tools evaluate:
    // Permission.merge(agentRuleset, sessionRuleset), exactly as session/tools.ts
    // builds it. Under a bypassing parent the child must not prompt at all.
    const child = worker(Permission.fromConfig({ edit: "ask", bash: "ask" }))
    const effective = Permission.merge(child.permission, derive([BYPASS], child))
    expect(Permission.evaluate("edit", "src/main.ts", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm -rf build", effective).action).toBe("allow")
  })

  test("a bypassing parent does not unlock the tools the child is meant not to have", () => {
    // The wildcard rides through, but the todowrite/task denies are appended
    // AFTER it and evaluate() takes the LAST match - so the child still cannot
    // spawn its own subagents or write the parent's todo list.
    const derived = derive([BYPASS])
    expect(Permission.evaluate("task", "general", derived).action).toBe("deny")
    expect(Permission.evaluate("todowrite", "*", derived).action).toBe("deny")
  })

  // The bug this pins: a sub-agent used the peer broker to interrupt a PRIMARY
  // session that had nothing to do with its task. `list_agents`/`send_message`
  // are unconditional registry builtins that never call `ctx.ask`, so the only
  // lever over them is the tool map the model is offered - and the wildcard
  // `"*": "allow"` in the agent defaults matches an unnamed permission id, so
  // before this deny they were silently allowed on every spawn.
  test("a subagent is not offered the peer tools, while a primary session still is", () => {
    const PEERS = ["list_agents", "send_message"]
    // The ruleset the child's tool map is actually resolved against, exactly as
    // session/llm/request.ts builds it: merge(agent.permission, session.permission).
    const child = worker()
    const childEffective = Permission.merge(child.permission, derive([], child))
    expect([...Permission.disabled(PEERS, childEffective)].sort()).toEqual(PEERS)

    // The primary keeps them. Same helper, but the PARENT's own ruleset is what
    // its tools see - it never goes through the subagent derivation.
    const primary = Permission.fromConfig({ "*": "allow" })
    expect(Permission.disabled(PEERS, primary).size).toBe(0)
  })

  test("a bypassing parent does not hand the peer tools to its subagent", () => {
    // The `*` allow rides through (YOLO must reach the child), but the peer
    // denies are appended after it and evaluate() takes the LAST match.
    const derived = derive([BYPASS])
    expect(Permission.evaluate("send_message", "*", derived).action).toBe("deny")
    expect(Permission.evaluate("list_agents", "*", derived).action).toBe("deny")
  })

  test("a subagent whose own definition names a peer tool keeps just that one", () => {
    // The opt-in escape hatch: a deliberately authored reporter. Granting
    // `send_message` must not also reopen the roster read.
    const reporter = worker(Permission.fromConfig({ send_message: "allow" }))
    const effective = Permission.merge(reporter.permission, derive([BYPASS], reporter))
    expect(Permission.disabled(["send_message"], effective).size).toBe(0)
    expect(Permission.disabled(["list_agents"], effective).has("list_agents")).toBe(true)
  })

  test("a subagent that owns task/todowrite keeps them under a bypassing parent", () => {
    const orchestrator = worker(Permission.fromConfig({ task: { "*": "allow" }, todowrite: "allow" }))
    const derived = derive([BYPASS], orchestrator)
    expect(Permission.evaluate("task", "general", derived).action).toBe("allow")
    expect(Permission.evaluate("todowrite", "*", derived).action).toBe("allow")
  })
})
