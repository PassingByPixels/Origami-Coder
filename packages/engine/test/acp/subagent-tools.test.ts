import { describe, expect, it } from "bun:test"
import { ACPSubagentTools } from "@/acp/subagent-tools"
import { ACPTools } from "@/acp/tools"
import { Permission } from "@/permission"
import { ToolSearch } from "@/tool/tool-search"

/**
 * t-di2u7z. The Tools pane's sub-agent matrix, as a projection.
 *
 * The defaults are the point of this file: the table is drawn from the state a
 * child would REALLY get at spawn, so `general` has to read `todowrite: off`
 * with nothing in anyone's config. It is asserted here against the archetypes'
 * own shapes rather than against the registry, so the check stays pure and does
 * not need an engine booted; test/tool/subagent-tool-states.test.ts drives the
 * live spawn path over the same two config keys.
 */

const TOOLS = ["read", "todowrite", "task", "browser", "webfetch", "lsp", "skill", "screenshot"]

/** `general` from agent/agent.ts: the permissive default row. It OWNS todowrite
 *  (t-f39xs2) and ships its own deferred list, both without any config.
 *
 *  A SHAPE, not the whole archetype: the owner's matrix is asserted cell by
 *  cell against the LIVE registry in test/tool/subagent-tool-states.test.ts.
 *  What this fixture is for is the projection's own rules - precedence,
 *  malformed blocks, which agents get a row - with no engine booted. */
const general = {
  name: "general",
  mode: "subagent" as const,
  native: true,
  description: "General-purpose agent",
  permission: Permission.fromConfig({ "*": "allow", todowrite: "allow" }),
  tool_search: { defer: ["webfetch", "websearch", "session_search", "browser", "board_*", "webmcp_*", "screenshot"] },
}

/** `explore` from agent/agent.ts: deny-by-default with a read-only allowlist. */
const explore = {
  name: "explore",
  mode: "subagent" as const,
  native: true,
  permission: Permission.fromConfig({
    "*": "deny",
    read: "allow",
    webfetch: "allow",
    skill: "allow",
    screenshot: "allow",
  }),
  tool_search: { defer: ["skill", "webfetch", "websearch", "session_search", "screenshot"] },
}

/** A markdown-defined agent, as `config.agent` carries it - `mode: all`. */
const orchestrator = {
  name: "orchestrator",
  mode: "all" as const,
  permission: Permission.fromConfig({ "*": "allow", task: "allow" }),
}

const project = (config: unknown = {}, agents: ACPSubagentTools.SubagentInfo[] = [general, explore, orchestrator]) =>
  ACPSubagentTools.project({
    agents,
    tools: TOOLS,
    settings: ACPTools.readSettings(config),
    config,
  })

const row = (rows: ACPSubagentTools.SubagentRow[], agent: string) => rows.find((item) => item.agent === agent)!

describe("the sub-agent matrix defaults", () => {
  it("shows general's whole verdict with no config anywhere", () => {
    const states = row(project(), "general").states
    // t-f39xs2: todowrite is the archetype's own, not a config line...
    expect(states["todowrite"]).toBe("loaded")
    // ...its default list is one catalog line each...
    expect(states["webfetch"]).toBe("deferred")
    expect(states["browser"]).toBe("deferred")
    // ...and the tools it said nothing about are not collateral damage.
    expect(states["read"]).toBe("loaded")
    expect(states["lsp"]).toBe("loaded")
  })

  it("defers an archetype's own list for that archetype only", () => {
    const rows = project()
    // `webfetch` is on nobody's workspace list: general and explore defer it
    // because their own definitions do, and the markdown agent does not.
    expect(row(rows, "explore").states["webfetch"]).toBe("deferred")
    expect(row(rows, "orchestrator").states["webfetch"]).toBe("loaded")
  })

  it("shows task OFF for every agent whose definition does not name it", () => {
    const rows = project()
    // The nesting rule, drawn: `general` and `explore` cannot delegate...
    expect(row(rows, "general").states["task"]).toBe("off")
    expect(row(rows, "explore").states["task"]).toBe("off")
    // ...and the agent whose own definition names `task` can.
    expect(row(rows, "orchestrator").states["task"]).toBe("loaded")
  })

  it("shows explore's whole verdict with no config anywhere", () => {
    const states = row(project(), "explore").states
    expect(states["read"]).toBe("loaded")
    // t-f39xs2: the owner's matrix marks these DEFERRED, not off, so explore's
    // cage has to name them - a denied tool never reaches the deferral
    // decision, and the row would read `off` however the D list was written.
    expect(states["skill"]).toBe("deferred")
    expect(states["screenshot"]).toBe("deferred")
    // ...while the rest of the deny-by-default cage is untouched.
    expect(states["lsp"]).toBe("off")
    // Denied, because explore's definition does not name it and
    // subagent-permissions.ts closes what a child does not own.
    expect(states["todowrite"]).toBe("off")
  })

  it("defers what the workspace defers, per agent", () => {
    // `browser` is on BUILTIN_DEFER, so it is one catalog line by default.
    expect(row(project(), "general").states["browser"]).toBe("deferred")
  })

  it("a workspace-wide OFF beats everything for every row", () => {
    const rows = project({ tools: { webfetch: false } })
    expect(row(rows, "general").states["webfetch"]).toBe("off")
    expect(row(rows, "orchestrator").states["webfetch"]).toBe("off")
  })
})

describe("the sub-agent matrix reads the agent's own block", () => {
  it("DEFERRED: `tool_search.defer` under the agent moves one tool for that agent only", () => {
    const rows = project({ agent: { general: { tool_search: { defer: ["lsp"] } } } })
    expect(row(rows, "general").states["lsp"]).toBe("deferred")
    expect(row(rows, "orchestrator").states["lsp"]).toBe("loaded")
  })

  it("ON: `tool_search.always` un-defers a default for that agent only", () => {
    const rows = project({ agent: { general: { tool_search: { always: ["browser"] } } } })
    expect(row(rows, "general").states["browser"]).toBe("loaded")
    expect(row(rows, "orchestrator").states["browser"]).toBe("deferred")
  })

  it("a user block beats the ARCHETYPE's own list, tool by tool", () => {
    // t-f39xs2 layers the archetype default under the config block. Naming one
    // tool must not drop the rest of the archetype's list.
    const rows = project({ agent: { general: { tool_search: { always: ["webfetch"] } } } })
    expect(row(rows, "general").states["webfetch"]).toBe("loaded")
    expect(row(rows, "general").states["browser"]).toBe("deferred")
  })

  it("survives a hand-edited block that is the wrong shape", () => {
    // origami.json is hand-editable: a malformed block must leave the row at
    // its defaults, never blank it or throw.
    const rows = project({ agent: { general: { tool_search: { defer: "lsp" } } } })
    expect(row(rows, "general").states["lsp"]).toBe("loaded")
    expect(row(rows, "general").states["browser"]).toBe("deferred")
  })

  it("a deferral list cannot smuggle a denied tool back", () => {
    // OFF outranks DEFERRED, the order session/tools.ts applies.
    const rows = project({ agent: { explore: { tool_search: { always: ["lsp"] } } } })
    expect(row(rows, "explore").states["lsp"]).toBe("off")
  })
})

describe("which agents get a row", () => {
  it("drops primary and hidden agents and sorts by name", () => {
    const rows = project({}, [
      orchestrator,
      general,
      { name: "build", mode: "primary" as const, permission: [] },
      { name: "goal-critic", mode: "subagent" as const, hidden: true, permission: [] },
    ])
    expect(rows.map((item) => item.agent)).toEqual(["general", "orchestrator"])
  })

  it("says which rows are engine archetypes and which are the user's own", () => {
    const rows = project()
    expect(row(rows, "general").native).toBe(true)
    expect(row(rows, "orchestrator").native).toBe(false)
    expect(row(rows, "general").description).toBe("General-purpose agent")
  })
})

describe("the matrix travels with the tool list", () => {
  it("carries one state per listed tool and nothing else", () => {
    const result = ACPTools.project(
      [
        { id: "read", description: "read a file" },
        { id: "todowrite", description: "write the list" },
      ],
      {},
      new Map(),
      [],
      [general],
    )
    expect(result.subagents).toHaveLength(1)
    expect(Object.keys(result.subagents[0]!.states).sort()).toEqual(["read", "todowrite"])
    expect(result.subagents[0]!.states["todowrite"]).toBe("loaded")
  })

  it("is empty, not absent, when the registry could not be read", () => {
    const result = ACPTools.project([{ id: "read", description: "read a file" }], {})
    expect(result.subagents).toEqual([])
  })

  it("never lists a repair-only tool as a column", () => {
    const result = ACPTools.project(
      [
        { id: "read", description: "read a file" },
        { id: "invalid", description: "repair target" },
      ],
      {},
      new Map(),
      [],
      [general],
    )
    expect(Object.keys(result.subagents[0]!.states)).toEqual(["read"])
  })
})

// t-h8s3xg. EVERY ROW HERE IS A CHILD, so at the default `subagent_depth` no
// row can spawn - whatever its permission block says. The pane has to say so
// in words, because `off` on its own reads as a setting the user may cycle and
// this one they may not.
describe("the nesting cap in the matrix", () => {
  /** The owner's own block: `task` allowed AND pinned loaded. Without the cap
   *  this row reads `task: loaded`, which is what the ledger showed while a
   *  child was being offered a tool it could never call. */
  const owner = {
    agent: {
      general: { permission: { task: "allow" }, tool_search: { always: ["task"] } },
    },
  }
  /** `general` as the live registry hands it over once that block is merged in:
   *  the config `permission` lands on `Agent.Info.permission` (agent.ts build),
   *  which is what the projection reads. Without this the row would be `off` by
   *  permission and the cap would prove nothing. */
  const allowed = { ...general, permission: Permission.fromConfig({ "*": "allow", task: "allow" }) }

  it("marks task, task_list and task_stop unavailable, with the reason, while the cap is 1", () => {
    const result = ACPTools.project(
      [
        { id: "task", description: "spawn an agent" },
        { id: "task_list", description: "list tasks" },
        { id: "task_stop", description: "stop a task" },
        { id: "read", description: "read a file" },
      ],
      { ...owner, subagent_depth: 1 },
      new Map(),
      [],
      [allowed],
    )
    const row = result.subagents[0]!
    for (const id of ["task", "task_list", "task_stop"]) {
      expect(`${id}=${row.states[id]}`).toBe(`${id}=off`)
      expect(row.unavailable?.[id]).toBe("nested sub-agents need subagent_depth ≥ 2")
    }
    // Only those three, and nothing else on the row moved.
    expect(Object.keys(row.unavailable ?? {}).sort()).toEqual(["task", "task_list", "task_stop"])
    expect(row.states["read"]).toBe("loaded")
  })

  it("an unset subagent_depth is the same as 1", () => {
    const result = ACPTools.project([{ id: "task", description: "spawn" }], owner, new Map(), [], [allowed])
    expect(result.subagents[0]!.states["task"]).toBe("off")
    expect(result.subagents[0]!.unavailable?.["task"]).toContain("subagent_depth")
  })

  it("subagent_depth 2 leaves the row exactly as the config wrote it", () => {
    const result = ACPTools.project(
      [{ id: "task", description: "spawn" }],
      { ...owner, subagent_depth: 2 },
      new Map(),
      [],
      [allowed],
    )
    expect(result.subagents[0]!.states["task"]).toBe("loaded")
    expect(result.subagents[0]!.unavailable).toBeUndefined()
  })
})

describe("ToolSearch settings read from config", () => {
  it("is the same reader the workspace rows use", () => {
    expect(ACPTools.readSettings({ experimental: { tool_search: { defer: ["webfetch"] } } })).toEqual(
      ToolSearch.settings({ defer: ["webfetch"] }),
    )
  })
})
