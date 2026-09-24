import { describe, expect, it as bunIt, afterEach } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import type { PermissionV1 } from "@origami/core/v1/permission"
import { ProviderV2 } from "@origami/core/provider"
import { ACPSubagentTools } from "@/acp/subagent-tools"
import { ACPTools } from "@/acp/tools"
import { Agent } from "@/agent/agent"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { ToolSearch } from "@/tool/tool-search"
import { Truncate } from "@/tool/truncate"
import type { Provider } from "@/provider/provider"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * t-di2u7z. THE THREE STATES OF ONE TOOL FOR ONE SUB-AGENT, at the spawn path.
 *
 * The Tools tab's sub-agent matrix writes two keys under the agent's own config
 * block and nothing else: `permission` decides whether the tool EXISTS for that
 * agent (on / off), and `tool_search: { always, defer }` decides how it is
 * PRESENTED (full schema / one catalog line). This file drives the engine end of
 * both - the derived child ruleset for on/off, and `SessionTools.resolve` for
 * the catalog - so a state the table can set that the engine ignores fails here.
 */

// -- ON / OFF: the derived child ruleset --------------------------------------

/** A permissive sub-agent whose definition names NOTHING the nesting rule
 *  guards - the shape `general` had before t-f39xs2, and the shape any ordinary
 *  markdown agent still has. */
const worker = (extra: PermissionV1.Ruleset = []): Agent.Info => ({
  name: "worker",
  mode: "subagent",
  permission: [...Permission.fromConfig({ "*": "allow" }), ...extra],
  options: {},
})

/** The ruleset a child's tools evaluate against - session/tools.ts. */
const effective = (subagent: Agent.Info) =>
  Permission.merge(subagent.permission, deriveSubagentSessionPermission({ parentSessionPermission: [], subagent }))

describe("per-agent ON/OFF at spawn", () => {
  bunIt("OFF is the default for a definition that does not name todowrite", () => {
    const cage = effective(worker())
    expect(Permission.evaluate("todowrite", "*", cage).action).toBe("deny")
    expect(Permission.disabled(["todowrite"], cage).has("todowrite")).toBe(true)
  })

  bunIt("ON is `permission: { todowrite: allow }` under the agent's block", () => {
    // What the table writes for the ON cell. It lands AFTER the definition's own
    // deny (agent.ts build() merges config permission last) and evaluate takes
    // the last match, so the child really gets the tool.
    const cage = effective(worker(Permission.fromConfig({ todowrite: "allow" })))
    expect(Permission.evaluate("todowrite", "*", cage).action).toBe("allow")
    expect(Permission.disabled(["todowrite"], cage).has("todowrite")).toBe(false)
  })

  bunIt("...and turning todowrite ON does not open the nesting rule", () => {
    // The one thing the table may not change: `task` stays denied to a child
    // whose definition does not name it, whatever the todowrite cell says.
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent: worker(Permission.fromConfig({ todowrite: "allow" })),
    })
    expect(derived).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(derived).not.toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
  })

  bunIt("OFF written on a tool the definition never mentioned still denies", () => {
    const cage = effective(worker(Permission.fromConfig({ webfetch: "deny" })))
    expect(Permission.disabled(["webfetch"], cage).has("webfetch")).toBe(true)
  })
})

// -- DEFERRED: the per-agent overlay on the deferral lists ---------------------

describe("ToolSearch.forAgent - the per-agent overlay", () => {
  const workspace = ToolSearch.settings({ defer: ["browser"], always: ["skill"] })

  bunIt("leaves the workspace settings untouched when the agent names nothing", () => {
    expect(ToolSearch.forAgent(workspace)).toBe(workspace)
    expect(ToolSearch.forAgent(workspace, {})).toBe(workspace)
  })

  bunIt("an agent's `always` beats the workspace `defer`", () => {
    const mine = ToolSearch.forAgent(workspace, { always: ["browser"] })
    expect(mine.defer).not.toContain("browser")
    expect(ToolSearch.deferred([{ id: "browser", kind: "builtin", deferrable: true }], mine)).toEqual([])
  })

  bunIt("an agent's `defer` beats the workspace `always`", () => {
    const mine = ToolSearch.forAgent(workspace, { defer: ["skill"] })
    expect(mine.always).not.toContain("skill")
    expect(ToolSearch.deferred([{ id: "skill", kind: "builtin" }], mine)).toEqual(["skill"])
  })

  bunIt("keeps every list entry the agent said nothing about", () => {
    const mine = ToolSearch.forAgent(workspace, { defer: ["skill"], always: ["browser"] })
    expect([...mine.defer].sort()).toEqual(["skill"])
    expect([...mine.always].sort()).toEqual(["browser"])
    expect(mine.enabled).toBe(true)
  })
})

// -- DEFERRED, through the real resolve ---------------------------------------

/** Two sub-agents that differ ONLY in their tool_search block, so a difference
 *  in the catalog below can come from nothing else. */
const AGENT_BLOCKS = {
  "tester-defer": { mode: "subagent", tool_search: { defer: ["skill"] } },
  "tester-always": { mode: "subagent", tool_search: { always: ["browser"] } },
} as const

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
  get: () => Effect.succeed({ agent: AGENT_BLOCKS } as never),
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Config.node,
      ToolRegistry.node,
      Agent.node,
      ToolSearch.node,
      Truncate.node,
      Session.node,
      Permission.node,
      Plugin.node,
      MCP.node,
      RuntimeFlags.node,
    ]),
    [
      [Config.node, configLayer],
      [RuntimeFlags.node, RuntimeFlags.layer()],
    ],
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const MODEL = { providerID: ProviderV2.ID.opencode, api: { id: "test", npm: "" } } as unknown as Provider.Model
const PROCESSOR = {
  message: { id: MessageID.make("msg_subagent_states") },
  updateToolCall: () => Effect.void,
  completeToolCall: () => Effect.void,
} as unknown as Parameters<typeof SessionTools.resolve>[0]["processor"]

const resolveFor = (agent: Agent.Info, id: string) =>
  SessionTools.resolve({
    agent,
    model: MODEL,
    session: { id: SessionID.make(id), permission: undefined } as unknown as Session.Info,
    processor: PROCESSOR,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as never,
  })

const catalogOf = (tools: Record<string, { description?: string }>) =>
  tools[ToolSearch.TOOL_SEARCH_TOOL]?.description ?? ""

describe("ACPTools.agents - the rows the Tools tab is drawn from", () => {
  it.instance("reads the live registry, and the matrix built from it matches the resolve above", () =>
    Effect.gen(function* () {
      const rows = yield* ACPTools.agents()
      const names = rows.map((agent) => agent.name)
      // Both config-declared sub-agents are there, beside the engine archetypes.
      expect(names).toContain("tester-defer")
      expect(names).toContain("general")
      expect(rows.find((agent) => agent.name === "general")?.native).toBe(true)
      expect(rows.find((agent) => agent.name === "tester-defer")?.native).toBeUndefined()

      // ...and the projection over them answers what resolve() answers below:
      // skill deferred for one agent, loaded for the other.
      const matrix = ACPSubagentTools.project({
        agents: rows,
        tools: ["skill", "browser", "todowrite"],
        settings: ToolSearch.settings(),
        config: { agent: AGENT_BLOCKS },
      })
      const state = (agent: string, tool: string) =>
        matrix.find((row) => row.agent === agent)?.states[tool]
      expect(state("tester-defer", "skill")).toBe("deferred")
      expect(state("tester-always", "skill")).toBe("loaded")
      expect(state("tester-always", "browser")).toBe("loaded")
      expect(state("tester-defer", "browser")).toBe("deferred")
      // t-f39xs2, off the LIVE `general` definition: the archetype owns
      // todowrite now, and no config block says so anywhere.
      expect(state("general", "todowrite")).toBe("loaded")
      // A primary agent is not a delegate and gets no row.
      expect(matrix.find((row) => row.agent === "build")).toBeUndefined()
    }),
  )

  // t-f39xs2, the ledger's whole point: the rows a user sees before they have
  // written a single line of config. `config: {}` is that, literally, and the
  // expectation below is the owner-approved default matrix for the two NATIVE
  // sub-agents, cell by cell. A cell that drifts fails here.
  const VERDICT: Record<string, Record<string, ACPSubagentTools.SubagentToolState>> = {
    general: {
      read: "loaded",
      grep: "loaded",
      todowrite: "loaded",
      question: "loaded",
      tool_search: "loaded",
      // Delegation stops here - `task` and both its sidecars.
      task: "off",
      task_list: "off",
      task_stop: "off",
      // The owner's own instruments.
      remember: "off",
      chart: "off",
      goal: "off",
      dream: "off",
      flock_who: "off",
      flock_ask: "off",
      // t-f89g49. A note to the OWNER about work outside the current job.
      side_quest: "off",
      // Reachable, one catalog line each.
      webfetch: "deferred",
      websearch: "deferred",
      session_search: "deferred",
      browser: "deferred",
      board_create: "deferred",
      webmcp_call: "deferred",
      screenshot: "deferred",
    },
    explore: {
      read: "loaded",
      grep: "loaded",
      git_diff: "loaded",
      lsp: "loaded",
      // Its own catalog, or the deferred list below is unreachable.
      tool_search: "loaded",
      skill: "deferred",
      screenshot: "deferred",
      session_search: "deferred",
      webfetch: "deferred",
      // Read-only means read-only: no shell, no writes, no todo list, no
      // delegation.
      bash: "off",
      edit: "off",
      write: "off",
      todowrite: "off",
      task: "off",
      side_quest: "off",
    },
  }

  it.instance("the native verdict with NO config present is the owner's matrix, cell by cell", () =>
    Effect.gen(function* () {
      const tools = [...new Set(Object.values(VERDICT).flatMap((cells) => Object.keys(cells)))]
      const matrix = ACPSubagentTools.project({
        agents: yield* ACPTools.agents(),
        tools,
        settings: ToolSearch.settings(),
        config: {},
      })
      for (const [agent, cells] of Object.entries(VERDICT)) {
        const states = matrix.find((row) => row.agent === agent)!.states
        for (const [tool, expected] of Object.entries(cells))
          expect(`${agent}.${tool}=${states[tool]}`).toBe(`${agent}.${tool}=${expected}`)
      }
    }),
  )
})

// -- t-ffjjxr: the ledger's task_list/task_stop verdict matches the spawn path --

describe("project() judges task_list/task_stop in the context of the agent's own task access", () => {
  const taskAgent = (extra: PermissionV1.Ruleset = []): ACPSubagentTools.SubagentInfo => ({
    name: "tasker",
    mode: "subagent",
    permission: [...Permission.fromConfig({ "*": "allow" }), ...extra],
  })

  bunIt("task allowed + task_list/task_stop deferred by config: the ledger reads loaded, like the spawn path", () => {
    const matrix = ACPSubagentTools.project({
      agents: [taskAgent(Permission.fromConfig({ task: "allow" }))],
      tools: ["task", "task_list", "task_stop"],
      settings: ToolSearch.settings({ defer: ["task_list", "task_stop"] }),
      config: {},
    })
    const states = matrix.find((row) => row.agent === "tasker")!.states
    expect(states.task).toBe("loaded")
    expect(states.task_list).toBe("loaded")
    expect(states.task_stop).toBe("loaded")
  })

  bunIt("task denied: task_list/task_stop follow the ordinary defer rules", () => {
    const matrix = ACPSubagentTools.project({
      agents: [taskAgent()],
      tools: ["task", "task_list", "task_stop"],
      settings: ToolSearch.settings({ defer: ["task_list", "task_stop"] }),
      config: {},
    })
    const states = matrix.find((row) => row.agent === "tasker")!.states
    expect(states.task).toBe("off")
    expect(states.task_list).toBe("deferred")
    expect(states.task_stop).toBe("deferred")
  })
})

describe("SessionTools.resolve honours the agent's own tool_search block", () => {
  it.instance("DEFERRED: the agent's `defer` moves a loaded builtin onto the catalog", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      // `skill` is deferred by nothing by default, so it is in the map for one agent...
      const plain = yield* resolveFor(yield* agents.get("tester-always"), "ses_states_plain")
      expect(Object.keys(plain)).toContain("skill")
      expect(catalogOf(plain)).not.toContain("- skill (builtin)")

      // ...and one catalog line for the agent whose own block defers it.
      const deferred = yield* resolveFor(yield* agents.get("tester-defer"), "ses_states_defer")
      expect(Object.keys(deferred)).not.toContain("skill")
      expect(catalogOf(deferred)).toContain("- skill (builtin)")
    }),
  )

  it.instance("ON: the agent's `always` pulls a defaulted-deferred builtin back in full", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      // `browser` is deferred by default (BUILTIN_DEFER) - the control.
      const defaulted = yield* resolveFor(yield* agents.get("tester-defer"), "ses_states_browser_default")
      expect(Object.keys(defaulted)).not.toContain("browser")
      expect(catalogOf(defaulted)).toContain("- browser (builtin)")

      const always = yield* resolveFor(yield* agents.get("tester-always"), "ses_states_browser_always")
      expect(Object.keys(always)).toContain("browser")
      expect(catalogOf(always)).not.toContain("- browser (builtin)")
    }),
  )
})
