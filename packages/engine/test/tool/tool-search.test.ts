import { describe, expect, it as bunIt, afterEach } from "bun:test"
import path from "path"
import fsp from "fs/promises"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { ToolSearch } from "@/tool/tool-search"
import { ToolEnabled } from "@/tool/tool-enabled"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { ToolJsonSchema } from "@/tool/json-schema"
import { SessionTools } from "@/session/tools"
import { LLMRequestPrep } from "@/session/llm/request"
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

  bunIt("never defers a core tool, however hard the config or a Def asks", () => {
    // The failure this guards against is not hypothetical: `deferrable: true`
    // is a one-line flag next to `description`, and `defer: ["*"]` is a
    // plausible thing for a user chasing context to write. Either one reaching
    // `read` or `edit` would leave the model a catalog line away from every
    // action it can take, with no error to explain it.
    const entries = [...ToolSearch.CORE].map((id) => entry(id, "builtin", true))

    expect(ToolSearch.deferred(entries, ToolSearch.settings({ defer: ["*"] }))).toEqual([])
    expect(ToolSearch.CORE.has("read")).toBe(true)
    expect(ToolSearch.CORE.has("edit")).toBe(true)
    expect(ToolSearch.CORE.has("bash")).toBe(true)
    expect(ToolSearch.CORE.has("task")).toBe(true)
    // The memory write path stays loaded: a `remember` must never need a search first.
    expect(ToolSearch.CORE.has("remember")).toBe(true)
  })

  bunIt("does not extend the core exemption to an MCP tool of the same name", () => {
    // CORE names BUILTIN ids. An MCP server is free to publish a tool called
    // `read`, and that one is a stranger's tool, not the loop's own.
    expect(ToolSearch.deferred([entry("read", "mcp")], ToolSearch.settings())).toEqual(["read"])
  })

  bunIt("defers the builtins whose Def files this change could not mark", () => {
    // browser / webmcp_* / flock_* carry no `deferrable` flag - it is declared
    // in tool-search.ts instead - so this is the only place that pins them.
    const ids = ToolSearch.deferred(
      [entry("browser", "builtin"), entry("webmcp_call", "builtin"), entry("flock_ask", "builtin")],
      ToolSearch.settings(),
    )

    expect(ids).toEqual(["browser", "webmcp_call", "flock_ask"])
    expect(ToolSearch.deferred([entry("browser", "builtin")], ToolSearch.settings({ always: ["browser"] }))).toEqual([])
  })

  bunIt("never defers tool_search itself", () => {
    const ids = ToolSearch.deferred(
      [entry(ToolSearch.TOOL_SEARCH_TOOL, "builtin", true)],
      ToolSearch.settings({ defer: ["*"] }),
    )

    expect(ids).toEqual([])
  })

  bunIt("keeps task_list and task_stop loaded when task is loaded, whatever defer says", () => {
    // t-fdveov. Both carry `deferrable: true` on their own Def AND get named
    // by a `defer` entry here - either alone already hid them before this
    // fix; the companion rule has to beat both at once.
    const overridden: string[] = []
    const ids = ToolSearch.deferred(
      [entry("task", "builtin"), entry("task_list", "builtin", true), entry("task_stop", "builtin", true)],
      ToolSearch.settings({ defer: ["task_list", "task_stop"] }),
      new Set(),
      (found) => overridden.push(...found),
    )

    expect(ids).toEqual([])
    expect(overridden.sort()).toEqual(["task_list", "task_stop"])
  })

  bunIt("defers task_list and task_stop by the normal rules when task itself is deferred or absent", () => {
    // task is not in CORE by accident of this fixture - it is simply not one
    // of `entries` here, the same as an agent whose ruleset denies it or a
    // build that switched it off before the deferral decision runs.
    const withoutTask = ToolSearch.deferred(
      [entry("task_list", "builtin", true), entry("task_stop", "builtin", true)],
      ToolSearch.settings(),
    )
    expect(withoutTask.sort()).toEqual(["task_list", "task_stop"])

    // task present but neither companion carries `deferrable` and neither is
    // named by `defer`: normal rules leave them loaded, same as any other
    // builtin.
    const notDeferrable = ToolSearch.deferred(
      [entry("task", "builtin"), entry("task_list", "builtin"), entry("task_stop", "builtin")],
      ToolSearch.settings(),
    )
    expect(notDeferrable).toEqual([])
  })

  bunIt("holds for a spawned child too: forSpawn's merged settings still cannot hide task's companions", () => {
    // t-fdveov acceptance: "main agent and forSpawn". A native archetype ships
    // its own default defer list (`Agent.Info.tool_search`), the user's
    // `agent.<name>.tool_search` block overlays it, and `forSpawn` is the one
    // function both session/tools.ts (the real spawn path) and
    // acp/subagent-tools.ts (the ledger) merge them through. Build settings
    // the same way a child with a native default AND a user override sees
    // them, and confirm the companions still survive both layers naming them.
    const native = { defer: ["task_list"] }
    const userConfig = { defer: ["task_stop"] }
    const childSettings = ToolSearch.forSpawn(ToolSearch.settings(), native, userConfig)
    const overridden: string[] = []

    const ids = ToolSearch.deferred(
      [entry("task", "builtin"), entry("task_list", "builtin", true), entry("task_stop", "builtin", true)],
      childSettings,
      new Set(),
      (found) => overridden.push(...found),
    )

    expect(ids).toEqual([])
    expect(overridden.sort()).toEqual(["task_list", "task_stop"])
  })

  bunIt("does not fire the override callback when nothing was actually overridden", () => {
    // task loaded, companions loaded too, but there is no `defer` entry and
    // no `deferrable` flag to override - the callback must stay silent, or
    // every session would log the INFO line whether anything happened or not.
    let called = false
    const ids = ToolSearch.deferred(
      [entry("task", "builtin"), entry("task_list", "builtin"), entry("task_stop", "builtin")],
      ToolSearch.settings(),
      new Set(),
      () => {
        called = true
      },
    )

    expect(ids).toEqual([])
    expect(called).toBe(false)
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

  bunIt("a two-letter word does not drag unrelated tools into the session", () => {
    // "in" and "a" are substrings of half the catalog; with thirty deferred
    // builtins one such query would permanently load five of them. Only the
    // tool the nouns name comes back.
    expect(ToolSearch.rank(catalog, "weather in a city").map((item) => item.id)).toEqual(["weather_current"])
    // A short term is still an exact id match, so a tool really named that way stays findable.
    expect(ToolSearch.score(candidate("db", "mcp", "Query the database", {}), [["db"]])).toBe(20)
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

/**
 * A `ToolSearch` service that defers nothing - the shape of
 * `experimental.tool_search: { enabled: false }`. Provided over the layer's own
 * instance rather than built as a third layer stack: only the settings differ.
 */
const disabledSearch = ToolSearch.Service.of({
  settings: () => Effect.succeed(ToolSearch.settings({ enabled: false })),
  loaded: () => Effect.succeed(new Set<string>() as ReadonlySet<string>),
  load: () => Effect.void,
})

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
      // ...and it is off the catalog, so the second call does not pay for it
      // twice. It used to assert the catalog was EMPTY and `tool_search` gone
      // with it, which was true only while the MCP mock was the sole deferred
      // tool in the build; widening deferral to the non-core builtins means
      // roughly thirty of them are still listed here. The claim that mattered -
      // a loaded tool leaves the catalog - is the one kept. `tool_search`
      // retiring when NOTHING is left is pinned separately below.
      expect(second[ToolSearch.TOOL_SEARCH_TOOL]!.description).not.toContain("weather_current")
    }),
  )

  withMcp.instance("offers no tool_search at all when the feature is switched off", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const tools = yield* SessionTools.resolve({
        agent: yield* agents.defaultInfo(),
        model: MODEL,
        session: { id: SessionID.make("ses_off"), permission: undefined } as unknown as Session.Info,
        processor: PROCESSOR,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as never,
      })
      expect(Object.keys(tools)).toContain(ToolSearch.TOOL_SEARCH_TOOL)

      const off = yield* SessionTools.resolve({
        agent: yield* agents.defaultInfo(),
        model: MODEL,
        session: { id: SessionID.make("ses_off2"), permission: undefined } as unknown as Session.Info,
        processor: PROCESSOR,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {} as never,
      }).pipe(Effect.provideService(ToolSearch.Service, disabledSearch))

      expect(Object.keys(off)).toContain("browser")
      expect(Object.keys(off)).not.toContain(ToolSearch.TOOL_SEARCH_TOOL)
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


// ── The agent's cage, in the PROMPT and not only in execution ────────────────
// Two halves have to hold together for item 2.2's per-agent trim: a denied tool
// must not be DECLARED (`session/llm/request.ts` resolveTools) and must not be
// a CATALOG LINE either (`session/tools.ts`). Both functions are driven here,
// in that order, because either one alone would pass while the model still paid
// for a tool it can never call.

const alwaysBrowserConfig = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
  get: () => Effect.succeed({ experimental: { tool_search: { always: ["browser"] } } } as never),
})

const withAlwaysBrowser = testEffect(
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
      [Config.node, alwaysBrowserConfig],
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [MCP.node, mcpMock],
    ],
  ),
)

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

/**
 * INVARIANT: THE DEFERRED CATALOG NEVER HIDES A TOOL THE PROMPT NAMES.
 *
 * Deferral is a bet that the model does not need a tool's schema until it asks
 * for it. The bet is off the moment the engine's OWN prompt text tells the
 * model to use a tool by id: the instruction then points at something that is
 * not in the tool list, and the model has no way to know the name it was just
 * given is one search away. `skill` is the case that was caught by hand -
 * `tool/skill.ts` carries a comment explaining why it is not deferrable, and
 * the reason is exactly this - but nothing pinned it, and nothing pinned any
 * of the others.
 *
 * WHAT THIS READS. The shipped prompt text: `src/session/prompt/*.txt`, which
 * is what the system prompt is built from, plus the reminder strings in
 * `session/reminders.ts` (comments stripped, since those are not sent). It
 * pulls out the two forms that unambiguously NAME a tool rather than use an
 * English word - a backticked identifier, and "the <id> tool" - and keeps the
 * ones that are real tool ids in this build.
 *
 * WHAT IT ASSERTS. Every one of those is in the tool MAP handed to the model,
 * not on the `tool_search` catalog. It runs against `SessionTools.resolve`
 * rather than the pure deferral rules on purpose: `deferrable: true` is a flag
 * on a Def, so a rules-level test would have to restate which tools carry it,
 * and would then agree with the code by construction instead of checking it.
 */
describe("the prompt never names a tool the catalog hides", () => {
  const PROMPT_DIR = path.join(import.meta.dir, "..", "..", "src", "session", "prompt")
  const REMINDERS = path.join(import.meta.dir, "..", "..", "src", "session", "reminders.ts")

  /** TS source minus its comment lines: only sent text should be scanned. */
  function sentText(source: string): string {
    return source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim()
        return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")
      })
      .join("\n")
  }

  /**
   * Tool ids that are also ordinary English words. A bare occurrence of one of
   * these in prose proves nothing ("read the file", "the goal is", "a task"),
   * so they are only counted when they appear in a form that can ONLY be a tool
   * id. Every other id is a coined name - `todowrite`, `webfetch`, `git_diff` -
   * and a bare occurrence of one of those in the prompt is the model being told
   * to use it. This list is about English, not about which tools are deferred.
   */
  const ALSO_ENGLISH = new Set([
    "read", "write", "edit", "task", "question", "goal", "file", "process", "chart", "browser",
    "skill", "dream", "execute", "grep", "glob", "list", "invalid", "remember", "screenshot",
    "shell", "bash", "patch", "plan", "search", "todo", "fetch",
  ])

  function namedTools(corpus: string, universe: ReadonlySet<string>): Set<string> {
    const found = new Set<string>()
    for (const match of corpus.matchAll(/`([a-z][a-z0-9_]*)`/g)) found.add(match[1]!)
    for (const match of corpus.matchAll(/\bthe ([a-z][a-z0-9_]*) tool\b/g)) found.add(match[1]!)
    // A coined id standing alone in the prose is a tool name and nothing else.
    for (const id of universe) {
      if (ALSO_ENGLISH.has(id)) continue
      if (new RegExp("\\b" + id + "\\b").test(corpus)) found.add(id)
    }
    return found
  }


  /** The ids on the `tool_search` catalog, read back off its description. */
  function catalogIds(description: string): Set<string> {
    const ids = new Set<string>()
    for (const match of description.matchAll(/^- ([a-z_][a-z0-9_]*) \((builtin|mcp)\)/gm)) ids.add(match[1]!)
    return ids
  }

  withMcp.instance("every tool id the shipped prompt text names is offered, not deferred", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const tools = yield* resolveOnce(yield* agents.defaultInfo())

      const offered = new Set(Object.keys(tools))
      const catalog = catalogIds(tools[ToolSearch.TOOL_SEARCH_TOOL]!.description!)
      // The catalog has to be non-empty or this test proves nothing: with
      // deferral off there is no way for it to fail.
      expect(catalog.size).toBeGreaterThan(0)

      const files = (yield* Effect.promise(() => fsp.readdir(PROMPT_DIR))).filter((name) => name.endsWith(".txt"))
      expect(files.length).toBeGreaterThan(0)
      const chunks: string[] = []
      for (const name of files) chunks.push(yield* Effect.promise(() => fsp.readFile(path.join(PROMPT_DIR, name), "utf8")))
      chunks.push(sentText(yield* Effect.promise(() => fsp.readFile(REMINDERS, "utf8"))))

      const universe = new Set([...offered, ...catalog])
      const named = [...namedTools(chunks.join("\n"), universe)].filter((id) => universe.has(id)).sort()

      // A corpus that names no tool at all would pass vacuously.
      expect(named.length).toBeGreaterThan(0)
      expect(named.filter((id) => !offered.has(id))).toEqual([])
    }),
  )

  withMcp.instance("...and the guard bites: a deferred tool named in that text would fail it", () =>
    Effect.gen(function* () {
      // The negative control. Without it the test above could pass because the
      // extractor found nothing interesting rather than because the invariant
      // holds. `browser` is deferred by default (tool-search.ts BUILTIN_DEFER),
      // so if the prompt said "the browser tool" the check must go red.
      const agents = yield* Agent.Service
      const tools = yield* resolveOnce(yield* agents.defaultInfo())
      const offered = new Set(Object.keys(tools))
      const catalog = catalogIds(tools[ToolSearch.TOOL_SEARCH_TOOL]!.description!)

      const pretend = [...namedTools("Use the browser tool to open a page.", new Set([...offered, ...catalog]))].filter((id) =>
        new Set([...offered, ...catalog]).has(id),
      )
      expect(pretend).toEqual(["browser"])
      expect(pretend.filter((id) => !offered.has(id))).toEqual(["browser"])
    }),
  )

  withMcp.instance("the repair tool is dispatchable but never advertised", () =>
    Effect.gen(function* () {
      // BOTH HALVES. `invalid` is where `experimental_repairToolCall` sends a
      // malformed call (session/llm.ts), so it must be in the map the AI SDK
      // dispatches from - a repair target that is missing is a repair that
      // cannot happen. It must equally never be sold to anyone as a capability:
      // not on the `tool_search` catalog, not in the Tools pane, and not in the
      // transparency capture's tool list.
      const agents = yield* Agent.Service
      const tools = yield* resolveOnce(yield* agents.defaultInfo())

      for (const id of SessionPromptCapture.REPAIR_ONLY_TOOLS) {
        expect(Object.keys(tools)).toContain(id)
        expect(catalogIds(tools[ToolSearch.TOOL_SEARCH_TOOL]!.description!).has(id)).toBe(false)
        // Not deferrable by any config, so the catalog can never gain it.
        expect(ToolSearch.deferred([entry(id, "builtin", true)], ToolSearch.settings({ defer: ["*"] }))).toEqual([])
        // ...and not switchable off by one either, or the repair path breaks.
        expect(ToolEnabled.isOff(id, ["*"])).toBe(false)
        expect(SessionPromptCapture.offeredToolNames(tools)).not.toContain(id)
      }
    }),
  )
})

describe("the agent cage reaches the prompt", () => {
  withMcp.instance("a denied tool is neither declared nor a catalog line", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.defaultInfo()
      const explore = yield* agents.get("explore")

      // `explore` is deny-by-default (agent/agent.ts:309-341): no browser.
      // `build` is not, so it is the control that proves the catalog line
      // exists at all and that its absence below is the cage, not a typo.
      const buildTools = yield* resolveFor(build, "ses_cage_build")
      const buildDeclared = LLMRequestPrep.resolveTools({
        tools: buildTools as never,
        agent: build,
        permission: undefined,
        user: {} as never,
      })
      expect(buildDeclared[ToolSearch.TOOL_SEARCH_TOOL]!.description).toContain("- browser (builtin)")
      expect(Object.keys(buildDeclared)).not.toContain("browser")

      const exploreTools = yield* resolveFor(explore, "ses_cage_explore")
      const exploreDeclared = LLMRequestPrep.resolveTools({
        tools: exploreTools as never,
        agent: explore,
        permission: undefined,
        user: {} as never,
      })
      expect(Object.keys(exploreDeclared)).not.toContain("browser")
      // The CATALOG LINE form, not the bare word: explore may reach `screenshot`
      // now (t-f39xs2) and that tool's own description says "outside the
      // browser", which a substring check reads as a leak that is not there.
      expect(exploreDeclared[ToolSearch.TOOL_SEARCH_TOOL]!.description).not.toContain("- browser (builtin)")
      // The tools it CAN run are still reachable: the catalog is not empty and
      // `tool_search` survived a ruleset that denies everything it does not name.
      expect(exploreDeclared[ToolSearch.TOOL_SEARCH_TOOL]!.description).toContain("- wiki_search (builtin)")
    }),
  )

  withAlwaysBrowser.instance("`always` puts a deferred builtin back in full", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.defaultInfo()
      const tools = yield* resolveFor(build, "ses_always_browser")

      expect(Object.keys(tools)).toContain("browser")
      expect(tools[ToolSearch.TOOL_SEARCH_TOOL]!.description).not.toContain("- browser (builtin)")
    }),
  )
})

// ── t-fdveov, on the real resolve path ───────────────────────────────────────
// The bug as UAT actually hit it: a `tool_search.defer` entry naming
// `task_list` and `task_stop` on the OWNER'S OWN chat (the primary/build
// agent, which the ticket's session was), where `task` itself is always
// offered. Reproduced here through `SessionTools.resolve` rather than the
// pure `deferred()` rules, so a regression that only showed up after `caged`
// or `off` filtering runs would still be caught.
const deferTaskCompanionsConfig = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
  get: () => Effect.succeed({ experimental: { tool_search: { defer: ["task_list", "task_stop"] } } } as never),
})

const withDeferredTaskCompanions = testEffect(
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
      [Config.node, deferTaskCompanionsConfig],
      // task_list/task_stop are only registered at all behind this flag
      // (tool/registry.ts:413) - off, the bug this ticket fixes cannot even
      // reproduce because there is no tool to hide.
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalBackgroundSubagents: true })],
      [MCP.node, mcpMock],
    ],
  ),
)

describe("t-fdveov — task's companions survive the real resolve path", () => {
  withDeferredTaskCompanions.instance(
    "task_list and task_stop are in the tool map, not the catalog, on the owner's own chat",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const build = yield* agents.defaultInfo()
        const tools = yield* SessionTools.resolve({
          agent: build,
          model: MODEL,
          session: { id: SessionID.make("ses_task_companions"), permission: undefined } as unknown as Session.Info,
          processor: PROCESSOR,
          bypassAgentCheck: false,
          messages: [],
          promptOps: {} as never,
        })

        expect(Object.keys(tools)).toContain("task")
        expect(Object.keys(tools)).toContain("task_list")
        expect(Object.keys(tools)).toContain("task_stop")
        const catalog = tools[ToolSearch.TOOL_SEARCH_TOOL]?.description ?? ""
        expect(catalog).not.toContain("- task_list (builtin)")
        expect(catalog).not.toContain("- task_stop (builtin)")
      }),
  )
})
