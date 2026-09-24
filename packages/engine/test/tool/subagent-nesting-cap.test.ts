// t-h8s3xg. A CHILD IS NEVER OFFERED THE TOOL IT CANNOT USE.
//
// The owner's origami.json carries, for `general` and `explore`:
//
//   permission:   { todowrite: allow, task: allow }
//   tool_search:  { defer: [todowrite], always: [task] }
//
// written by the Tools ledger. Those two lines lift the default `task: deny`
// `agent/subagent-permissions.ts` appends and pin the tool LOADED, so a child
// saw `task` in its list, called it, and read "Subagent depth limit reached
// (1)" - a limit it could do nothing about, on a key it was never told about.
//
// What is asserted here is ABSENCE at the spawn projection: with the default
// `subagent_depth`, a session that already has a parent resolves a catalog
// with no `task`, `task_list` or `task_stop` in it, config or no config. Raise
// the cap to 2 and the same child gets the tool back.

import { describe, expect, it } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ProviderV2 } from "@origami/core/provider"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionTools } from "@/session/tools"
import { SubagentDepth } from "@/session/subagent-depth"
import { ToolRegistry } from "@/tool/registry"
import { ToolSearch } from "@/tool/tool-search"
import { Truncate } from "@/tool/truncate"
import type { Provider } from "@/provider/provider"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

/** The owner's own block, verbatim in shape: task allowed AND pinned loaded. */
const OWNER_BLOCK = {
  general: {
    permission: { todowrite: "allow", task: "allow" },
    tool_search: { defer: ["todowrite"], always: ["task"] },
  },
} as const

const layerFor = (depth?: number) =>
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
      [
        Config.node,
        TestConfig.layer({
          directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
          get: () =>
            Effect.succeed({
              agent: OWNER_BLOCK,
              ...(depth === undefined ? {} : { subagent_depth: depth }),
            } as never),
        }),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer()],
    ],
  )

const capped = testEffect(layerFor())
const raised = testEffect(layerFor(2))

const MODEL = { providerID: ProviderV2.ID.opencode, api: { id: "test", npm: "" } } as unknown as Provider.Model
const PROCESSOR = {
  message: { id: MessageID.make("msg_subagent_nesting") },
  updateToolCall: () => Effect.void,
  completeToolCall: () => Effect.void,
} as unknown as Parameters<typeof SessionTools.resolve>[0]["processor"]

/** The catalog a REAL child session resolves: a parent row, a child row under
 *  it, and `SessionTools.resolve` over the live `general` definition - the same
 *  call `session/prompt.ts` makes for a spawned child. */
const childCatalog = Effect.fn("test.childCatalog")(function* () {
  const sessions = yield* Session.Service
  const agents = yield* Agent.Service
  const parent = yield* sessions.create({ title: "parent" })
  const child = yield* sessions.create({ parentID: parent.id, title: "child", agent: "general" })
  const tools = yield* SessionTools.resolve({
    agent: yield* agents.get("general"),
    model: MODEL,
    session: child,
    processor: PROCESSOR,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as never,
  })
  return { tools, parent, child }
})

/** The same call for the TOP-LEVEL chat, the control: nothing about this
 *  change may touch a session that has no parent. */
const primaryCatalog = Effect.fn("test.primaryCatalog")(function* () {
  const sessions = yield* Session.Service
  const agents = yield* Agent.Service
  const chat = yield* sessions.create({ title: "primary" })
  return yield* SessionTools.resolve({
    agent: yield* agents.get("general"),
    model: MODEL,
    session: chat,
    processor: PROCESSOR,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as never,
  })
})

const catalogLines = (tools: Record<string, { description?: string }>) =>
  tools[ToolSearch.TOOL_SEARCH_TOOL]?.description ?? ""

describe("A1 - the depth cap decides the child's catalog, not its permissions", () => {
  capped.instance("a child at the default cap gets no task, task_list or task_stop", () =>
    Effect.gen(function* () {
      const { tools } = yield* childCatalog()
      // The config says allow + always, and the tool is still absent: that is
      // the point. Absence, not a deny it could argue with.
      for (const id of SubagentDepth.NESTED_TASK_TOOLS) {
        expect(`declared:${id}=${Object.keys(tools).includes(id)}`).toBe(`declared:${id}=false`)
        expect(catalogLines(tools)).not.toContain(`- ${id} (builtin)`)
      }
      // A control from the same block: the config's OTHER lifted tool is
      // untouched, so this is the cap talking and not a broken config read.
      expect(Object.keys(tools)).toContain("todowrite")
    }),
  )

  capped.instance("the top-level chat is untouched", () =>
    Effect.gen(function* () {
      expect(Object.keys(yield* primaryCatalog())).toContain("task")
    }),
  )

  raised.instance("subagent_depth 2 gives the same child the tool back", () =>
    Effect.gen(function* () {
      const { tools } = yield* childCatalog()
      expect(Object.keys(tools)).toContain("task")
    }),
  )
})

describe("A2 - the words a capped agent reads", () => {
  it("name what to do instead of which key to raise", () => {
    expect(SubagentDepth.capMessage(undefined)).toBe(
      "This agent is already a sub-agent and nested sub-agents are off (subagent_depth 1). Finish the work yourself or report back to the parent.",
    )
    expect(SubagentDepth.capMessage(undefined)).not.toContain("Increase")
    expect(SubagentDepth.capMessage(3)).toContain("subagent_depth 3")
  })

  it("atCap counts a child as capped by default and not at depth 2", () => {
    expect(SubagentDepth.atCap(0, undefined)).toBe(false)
    expect(SubagentDepth.atCap(1, undefined)).toBe(true)
    expect(SubagentDepth.atCap(1, 2)).toBe(false)
    expect(SubagentDepth.atCap(2, 2)).toBe(true)
  })
})
