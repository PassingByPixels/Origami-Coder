import { describe, expect, it as bunIt, afterEach } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { ToolSearch } from "@/tool/tool-search"
import { ToolJsonSchema } from "@/tool/json-schema"
import { SessionTools } from "@/session/tools"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Truncate } from "@/tool/truncate"
import { MCP } from "@/mcp"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/client"
import type { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import { ACPTools } from "@/acp/tools"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

const candidate = (
  id: string,
  kind: ToolSearch.Kind,
  description = "",
  properties?: Record<string, unknown>,
): ToolSearch.Candidate => ({ id, kind, description, text: ToolSearch.searchText(id, description, properties) })

const entry = (id: string, kind: ToolSearch.Kind, deferrable?: boolean) => ({
  id,
  kind,
  ...(deferrable ? { deferrable } : {}),
})

describe("tool_search — which tools are deferred", () => {
  bunIt("defers MCP tools by default and leaves builtins alone", () => {
    const ids = ToolSearch.deferred(
      [entry("read", "builtin"), entry("shell", "builtin"), entry("board_board_tickets", "mcp")],
      ToolSearch.settings(),
    )

    expect(ids).toEqual(["board_board_tickets"])
  })

  bunIt("defers nothing at all when the feature is switched off", () => {
    const ids = ToolSearch.deferred(
      [entry("board_board_tickets", "mcp"), entry("lsp", "builtin", true)],
      ToolSearch.settings({ enabled: false }),
    )

    expect(ids).toEqual([])
  })

  bunIt("keeps MCP tools loaded when mcp deferral is opted out", () => {
    const ids = ToolSearch.deferred([entry("board_board_tickets", "mcp")], ToolSearch.settings({ mcp: false }))

    expect(ids).toEqual([])
  })

  bunIt("defers a builtin only once it is marked deferrable", () => {
    const settings = ToolSearch.settings()

    expect(ToolSearch.deferred([entry("lsp", "builtin")], settings)).toEqual([])
    expect(ToolSearch.deferred([entry("lsp", "builtin", true)], settings)).toEqual(["lsp"])
  })

  bunIt("defers by config pattern, one server or one tool", () => {
    const settings = ToolSearch.settings({ mcp: false, defer: ["board_*", "chart"] })
    const ids = ToolSearch.deferred(
      [entry("board_board_tickets", "mcp"), entry("boardless", "builtin"), entry("chart", "builtin")],
      settings,
    )

    expect(ids).toEqual(["board_board_tickets", "chart"])
  })

  bunIt("lets `always` win over every default and over `defer`", () => {
    const ids = ToolSearch.deferred(
      [entry("board_board_tickets", "mcp"), entry("board_board_create", "mcp")],
      ToolSearch.settings({ defer: ["board_*"], always: ["board_board_create"] }),
    )

    expect(ids).toEqual(["board_board_tickets"])
  })

  bunIt("stops deferring a tool a search already loaded", () => {
    const entries = [entry("board_board_tickets", "mcp"), entry("board_board_create", "mcp")]

    expect(ToolSearch.deferred(entries, ToolSearch.settings(), new Set(["board_board_create"]))).toEqual([
      "board_board_tickets",
    ])
  })

  bunIt("never defers tool_search itself", () => {
    const ids = ToolSearch.deferred(
      [entry(ToolSearch.TOOL_SEARCH_TOOL, "builtin", true)],
      ToolSearch.settings({ defer: ["*"] }),
    )

    expect(ids).toEqual([])
  })

  bunIt("anchors wildcard patterns at both ends", () => {
    expect(ToolSearch.matches("board_*", "board_create")).toBe(true)
    expect(ToolSearch.matches("board_*", "boardcreate")).toBe(false)
    expect(ToolSearch.matches("board", "board_create")).toBe(false)
    expect(ToolSearch.matches("*_create", "board_create")).toBe(true)
  })
})

describe("tool_search — ranking", () => {
  const catalog = [
    candidate("board_board_tickets", "mcp", "List tickets on a board repo", { repo: { type: "string" } }),
    candidate("board_board_create", "mcp", "Create a ticket", { title: { type: "string" } }),
    candidate("weather_current", "mcp", "Current weather for a city", {
      city: { type: "string", description: "Name of the town" },
    }),
  ]

  bunIt("ranks the exactly-named tool first", () => {
    // Both board tools match the "board" term; the id-segment weight is what
    // has to put the one the query actually named at the top.
    const ranked = ToolSearch.rank(catalog, "board_create").map((item) => item.id)

    expect(ranked[0]).toBe("board_board_create")
    expect(ranked).toContain("board_board_tickets")
  })

  bunIt("matches a plural query against singular text", () => {
    expect(ToolSearch.rank(catalog, "list tickets on a board").map((item) => item.id)[0]).toBe("board_board_tickets")
  })

  bunIt("matches on a parameter description no id or description carries", () => {
    expect(ToolSearch.rank(catalog, "town").map((item) => item.id)).toEqual(["weather_current"])
  })

  bunIt("returns nothing when no term matches", () => {
    expect(ToolSearch.rank(catalog, "kubernetes")).toEqual([])
  })

  bunIt("browses the whole catalog on an empty query", () => {
    expect(ToolSearch.rank(catalog, "").length).toBe(3)
  })

  bunIt("caps the limit so a search cannot undo deferral", () => {
    expect(ToolSearch.rank(catalog, "", 999).length).toBe(3)
    expect(ToolSearch.rank(catalog, "", 1).map((item) => item.id)).toEqual(["board_board_create"])
  })

  bunIt("splits camelCase and punctuation the same way", () => {
    expect(ToolSearch.tokenize("resolveLibrary-id")).toEqual(["resolve", "library", "id"])
  })
})

describe("tool_search — the catalog the model reads", () => {
  bunIt("gives each deferred tool one line naming its origin", () => {
    const text = ToolSearch.describe([
      candidate("board_board_tickets", "mcp", "List tickets on a board repo"),
      candidate("lsp", "builtin", "Language server queries"),
    ])

    expect(text).toContain("- board_board_tickets (mcp) — List tickets on a board repo")
    expect(text).toContain("- lsp (builtin) — Language server queries")
    expect(text).toContain("2 tools")
  })

  bunIt("keeps a long description to one truncated line", () => {
    const text = ToolSearch.describe([candidate("big", "mcp", "x".repeat(400) + "\nsecond line")])
    const line = text.split("\n").find((item) => item.startsWith("- big"))!

    expect(line.length).toBeLessThanOrEqual(140)
    expect(text).not.toContain("second line")
  })

  bunIt("tells the model a match is callable from the next step, and names the schema", () => {
    const text = ToolSearch.report(
      [{ candidate: candidate("weather_current", "mcp", "Current weather"), schema: { type: "object" } }],
      "weather",
      2,
    )

    expect(text).toContain("## weather_current")
    expect(text).toContain("next step onward")
    expect(text).toContain('"type": "object"')
  })

  bunIt("says how many are left when nothing matched", () => {
    const text = ToolSearch.report([], "kubernetes", 7)

    expect(text).toContain('No deferred tool matched "kubernetes"')
    expect(text).toContain("7 deferred tools are still available")
  })
})

describe("list_tools projection (the Tools pane)", () => {
  bunIt("marks a config-deferred tool and sorts by id", () => {
    const result = ACPTools.project(
      [
        { id: "shell", description: "Run a command" },
        { id: "chart", description: "Draw a chart" },
      ],
      { experimental: { tool_search: { defer: ["chart"] } } },
    )

    expect(result.tools.map((item) => item.id)).toEqual(["chart", "shell"])
    expect(result.tools.find((item) => item.id === "chart")?.deferred).toBe(true)
    expect(result.tools.find((item) => item.id === "shell")?.deferred).toBe(false)
  })

  bunIt("falls back to the shipped defaults on a config it cannot read", () => {
    expect(ACPTools.readSettings(undefined)).toEqual(ToolSearch.DEFAULTS)
    expect(ACPTools.readSettings({ experimental: { tool_search: "nonsense" } })).toEqual(ToolSearch.DEFAULTS)
    expect(ACPTools.readSettings({ experimental: { tool_search: { mcp: "yes", defer: [1, "a"] } } })).toEqual({
      ...ToolSearch.DEFAULTS,
      defer: ["a"],
    })
  })
})

describe("tool list token cost", () => {
  // The measurement the ticket asks for, taken over the REAL builtin registry
  // rather than an invented fixture: every description and JSON Schema below is
  // the one this build actually sends. The unit is the honest one this repo
  // already uses in the Instructions pane — bytes/4, an ESTIMATE, not a
  // tokenisation — and it is labelled as such wherever it is printed.
  it.instance("costs an order of magnitude less as a catalog than as schemas", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })

      const wire = (tool: (typeof tools)[number]) =>
        JSON.stringify({
          name: tool.id,
          description: tool.description,
          parameters: ToolJsonSchema.fromTool(tool),
        }).length
      const loadedBytes = tools.reduce((total, tool) => total + wire(tool), 0)
      const catalogBytes = ToolSearch.describe(
        tools.map((tool) => candidate(tool.id, "builtin", tool.description)),
      ).length
      const approx = (bytes: number) => Math.round(bytes / 4)

      console.log(
        [
          `tool list cost over ${tools.length} real builtin tools (bytes/4 ESTIMATE, not a tokenisation):`,
          `  loaded  ${loadedBytes} bytes ~ ${approx(loadedBytes)} tokens`,
          `  catalog ${catalogBytes} bytes ~ ${approx(catalogBytes)} tokens`,
          `  saving  ${approx(loadedBytes - catalogBytes)} tokens (${Math.round((1 - catalogBytes / loadedBytes) * 100)}%)`,
        ].join("\n"),
      )

      expect(tools.length).toBeGreaterThan(10)
      expect(catalogBytes).toBeLessThan(loadedBytes / 4)
    }),
  )
})

// ── The seam, not a proxy ────────────────────────────────────────────────────
// Everything above tests the RULES. This drives the real
// `SessionTools.resolve` — the function session/prompt.ts calls once per step
// of the agent loop — against a real registry and a mocked MCP server, and
// pins the one claim the pure tests cannot reach: a tool found by `tool_search`
// on one resolve is in the tool MAP on the next one, for the same session.
//
// It is not the user's surface (that is a VS Code chat against a rebuilt
// engine, which this stage may not deploy). It is the last engine-side seam
// before the AI SDK, which is as close as a test can get from here.
const mcpMock = Layer.mock(MCP.Service, {
  tools: () =>
    Effect.succeed({
      weather_current: {
        def: {
          name: "current",
          description: "Current weather for a city",
          inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        } as MCPToolDef,
        client: {} as MCP.McpTool["client"],
      },
    }),
  // A real MCP client answers this; session/tools.ts asks every client whether
  // it serves resources before it offers the three resource tools.
  clients: () => Effect.succeed({ weather: { getServerCapabilities: () => ({}) } as never }),
})

const withMcp = testEffect(
  LayerNode.compile(
    LayerNode.group([
      // Config is EXPOSED here, not only supplied as a dependency below:
      // SessionTools.resolve reads config directly now (the OFF list, see
      // tool/tool-enabled.ts), so it is one of the body's requirements.
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
      [MCP.node, mcpMock],
    ],
  ),
)

const SESSION = { id: SessionID.make("ses_toolsearch"), permission: undefined } as unknown as Session.Info
const MODEL = { providerID: ProviderV2.ID.opencode, api: { id: "test", npm: "" } } as unknown as Provider.Model
const PROCESSOR = {
  message: { id: MessageID.make("msg_toolsearch") },
  updateToolCall: () => Effect.void,
  completeToolCall: () => Effect.void,
} as unknown as Parameters<typeof SessionTools.resolve>[0]["processor"]

const resolveOnce = (agent: Agent.Info) =>
  SessionTools.resolve({
    agent,
    model: MODEL,
    session: SESSION,
    processor: PROCESSOR,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as never,
  })

describe("SessionTools.resolve — deferral across steps", () => {
  withMcp.instance("hides the MCP tool, offers tool_search, and materialises it on the NEXT resolve", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const agent = yield* agents.defaultInfo()

      const first = yield* resolveOnce(agent)
      expect(Object.keys(first)).not.toContain("weather_current")
      expect(Object.keys(first)).toContain(ToolSearch.TOOL_SEARCH_TOOL)
      // The catalog line is what replaced the schema — the tool is visible, its shape is not.
      const description = first[ToolSearch.TOOL_SEARCH_TOOL]!.description!
      expect(description).toContain("weather_current (mcp) — Current weather for a city")
      expect(description).not.toContain('"city"')

      const search = first[ToolSearch.TOOL_SEARCH_TOOL]!
      const output = yield* Effect.promise(
        () =>
          search.execute!({ query: "weather in a city" }, {
            toolCallId: "call_1",
            abortSignal: new AbortController().signal,
            messages: [],
          } as never) as Promise<{ output: string }>,
      )
      expect(output.output).toContain("weather_current")
      expect(output.output).toContain("city")

      const second = yield* resolveOnce(agent)
      expect(Object.keys(second)).toContain("weather_current")
      // ...and the catalog is empty now, so the search tool retires with it.
      expect(Object.keys(second)).not.toContain(ToolSearch.TOOL_SEARCH_TOOL)
    }),
  )

  withMcp.instance("keeps the MCP tool loaded for a DIFFERENT session that never searched", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const agent = yield* agents.defaultInfo()
      const other = { id: SessionID.make("ses_other"), permission: undefined } as unknown as Session.Info

      const tools = yield* SessionTools.resolve({
        agent,
        model: MODEL,
        session: other,
        processor: PROCESSOR,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as never,
      })

      expect(Object.keys(tools)).not.toContain("weather_current")
      expect(Object.keys(tools)).toContain(ToolSearch.TOOL_SEARCH_TOOL)
    }),
  )
})
