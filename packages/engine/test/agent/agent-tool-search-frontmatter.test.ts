import { describe, expect, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ProviderV2 } from "@origami/core/provider"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
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
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * t-f39xs2. A FILE-DEFINED agent's `tool_search` frontmatter, through the real
 * loader to the real resolve.
 *
 * The per-agent overlay itself is unit-tested (test/tool/subagent-tool-states.ts);
 * what only a real definition FILE can answer is whether the block survives the
 * markdown loader at all - it is a nested object in frontmatter, and the same
 * loader pushes every key it does not know onto `options`. So the fixture is
 * written into a temp config directory before the engine boots, and the
 * assertion is made on the tool map `SessionTools.resolve` hands the model.
 */

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
    [[RuntimeFlags.node, RuntimeFlags.layer()]],
  ),
)

/** The definition file, on disk BEFORE the engine reads its config: the markdown
 *  agents are merged into `config.agent` at load, which is the key the spawn
 *  path reads. `defer` and `always` together, so one block proves both lists. */
const withDefinition = {
  init: (directory: string) =>
    Effect.promise(async () => {
      const dir = path.join(directory, ".origami", "agent")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        path.join(dir, "deferrer.md"),
        [
          "---",
          "description: A file-defined agent with its own deferral lists",
          "mode: subagent",
          "tool_search:",
          "  defer:",
          "    - skill",
          "  always:",
          "    - browser",
          "---",
          "You are a fixture.",
          "",
        ].join("\n"),
      )
    }),
}

const MODEL = { providerID: ProviderV2.ID.opencode, api: { id: "test", npm: "" } } as unknown as Provider.Model
const PROCESSOR = {
  message: { id: MessageID.make("msg_frontmatter_tool_search") },
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

afterEach(async () => {
  await disposeAllInstances()
})

describe("a markdown agent's tool_search frontmatter reaches the spawn path", () => {
  it.instance(
    "the block survives the loader and lands in config.agent",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const cfg = yield* Config.Service.use((svc) => svc.get())
        expect(cfg.agent?.["deferrer"]?.tool_search).toEqual({ defer: ["skill"], always: ["browser"] })
        // It is a KNOWN key, so the loader must not also spill it onto options.
        expect((yield* Agent.Service.use((svc) => svc.get("deferrer"))).options["tool_search"]).toBeUndefined()
      }),
    withDefinition,
  )

  it.instance(
    "`defer` from the file hides a loaded builtin behind the catalog at spawn",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const tools = yield* resolveFor(yield* agents.get("deferrer"), "ses_frontmatter_defer")
        expect(Object.keys(tools)).not.toContain("skill")
        expect(catalogOf(tools)).toContain("- skill (builtin)")
      }),
    withDefinition,
  )

  it.instance(
    "`always` from the file pulls a defaulted-deferred builtin back in full",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        // `browser` is on BUILTIN_DEFER, so only the file's `always` can load it.
        const tools = yield* resolveFor(yield* agents.get("deferrer"), "ses_frontmatter_always")
        expect(Object.keys(tools)).toContain("browser")
        expect(catalogOf(tools)).not.toContain("- browser (builtin)")
      }),
    withDefinition,
  )

  // t-f39xs2 acceptance 1, through a REAL spawn resolve rather than a ruleset:
  // the tool map `general` is handed carries todowrite. Before the archetype
  // named the tool, subagent-permissions.ts caged it out of exactly this map.
  it.instance(
    "a general child is handed todowrite, and its D list is catalog lines",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const tools = yield* resolveFor(yield* agents.get("general"), "ses_frontmatter_native")
        expect(Object.keys(tools)).toContain("todowrite")
        // The D list is one line each, not a schema. NOTE: several of these
        // builtins also carry their own `deferrable` flag, so this asserts the
        // REQUIREMENT, not which of the two mechanisms delivered it - the
        // archetype list is what the Sub-agents ledger reads, and
        // test/acp/subagent-tools.test.ts pins it there.
        const catalog = catalogOf(tools)
        for (const tool of ["webfetch", "websearch", "session_search", "browser", "screenshot"])
          expect([tool, catalog.includes(`- ${tool} (builtin)`)]).toEqual([tool, true])
        expect(Object.keys(tools)).not.toContain("browser")
      }),
    withDefinition,
  )
})
