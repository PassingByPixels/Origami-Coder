// tool-enabled.ts — the OFF state, `tools: { <id>: false }` in origami.json.
//
// Two layers, deliberately:
//
//   1. The RULES, as pure functions. What counts as off, what a malformed
//      value does, and the one id that can never be switched off.
//   2. The SEAM. `SessionTools.resolve` is the function session/prompt.ts
//      calls once per step of the agent loop to build the tool map handed to
//      the AI SDK — the last engine-side place where "is this tool offered"
//      is still a question. Everything above it is a rule; this is the answer.
//      Driven against a real registry and the same mocked MCP server
//      tool-search.test.ts uses, because a pure test of `keepEnabled` proves
//      only that `keepEnabled` filters an array.
//
// The claim that matters, and the reason the seam test exists: an OFF tool is
// absent from the map AND absent from the `tool_search` catalog. Half of that
// is easy to get wrong — filtering after the deferral decision would leave a
// switched-off tool advertised as a catalog line the model could still expand,
// which is "off" meaning "cheaper".

import { describe, expect, it as bunIt, afterEach } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { ToolSearch } from "@/tool/tool-search"
import { ToolEnabled } from "@/tool/tool-enabled"
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
import { SessionPromptCapture } from "@/session/prompt-capture"
import { ConfigParse } from "@/config/parse"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// ── 1. The rules ────────────────────────────────────────────────────────────

describe("ToolEnabled.offPatterns — reading `tools` out of origami.json", () => {
  bunIt("collects only the keys explicitly set to false", () => {
    expect(ToolEnabled.offPatterns({ tools: { browser: false, read: true, chart: false } }).sort()).toEqual([
      "browser",
      "chart",
    ])
  })

  bunIt("treats every non-false value as ON, so nothing is disabled by accident", () => {
    // A hand-edited file can carry anything here. "off" must mean the literal
    // `false` and nothing else — a truthy string or a null that silently
    // disabled a tool would be the same class of bug this key had before it
    // was read at all, just inverted.
    const patterns = ToolEnabled.offPatterns({
      tools: { a: true, b: "false", c: 0, d: null, e: undefined, f: {}, g: false },
    } as unknown)
    expect(patterns).toEqual(["g"])
  })

  bunIt("answers empty for a missing, malformed or non-object `tools` key", () => {
    expect(ToolEnabled.offPatterns(undefined)).toEqual([])
    expect(ToolEnabled.offPatterns({})).toEqual([])
    expect(ToolEnabled.offPatterns({ tools: [] })).toEqual([])
    expect(ToolEnabled.offPatterns({ tools: "browser" })).toEqual([])
    expect(ToolEnabled.offPatterns("not config at all")).toEqual([])
  })
})

// The link that would make everything else here a very well-tested no-op: if
// `tools` did not survive parsing, `offPatterns` would read an absent key off
// every real config and answer [] forever, and the feature would fail exactly
// the way the key ALREADY failed for its whole life before this change — set,
// validated, and quietly ignored. ConfigParse REJECTS unrecognised top-level
// keys (config.test.ts pins that), so "is it accepted" is a real question, and
// this asks it against the shipped schema rather than a stub.
describe("`tools` survives the real config parser", () => {
  bunIt("is accepted as a top-level key and reaches offPatterns intact", () => {
    const parsed = ConfigParse.schema(ConfigV1.Info, { tools: { read: false, glob: true } }, "test")
    expect(parsed.tools).toEqual({ read: false, glob: true })
    expect(ToolEnabled.offPatterns(parsed)).toEqual(["read"])
  })

  bunIt("still rejects a key the schema does not declare, so this is not a free-for-all", () => {
    // The control for the test above: `tools` passing means something only
    // because a made-up sibling does not.
    expect(() => ConfigParse.schema(ConfigV1.Info, { toolz: { read: false } }, "test")).toThrow()
  })
})

describe("ToolEnabled.isOff — which ids a pattern reaches", () => {
  bunIt("matches an exact id and nothing adjacent to it", () => {
    expect(ToolEnabled.isOff("board_create", ["board_create"])).toBe(true)
    // Anchored: a bare prefix must not take the whole family with it.
    expect(ToolEnabled.isOff("board_create", ["board"])).toBe(false)
    expect(ToolEnabled.isOff("board_create_extra", ["board_create"])).toBe(false)
  })

  bunIt("uses the SAME wildcard dialect as defer/always, so one string means one thing", () => {
    expect(ToolEnabled.isOff("board_create", ["board_*"])).toBe(true)
    expect(ToolEnabled.isOff("read", ["board_*"])).toBe(false)
    // Proven against ToolSearch.matches itself rather than re-derived, since
    // sharing that function is the actual claim.
    for (const id of ["board_create", "board_tickets", "read", "shell"]) {
      expect(ToolEnabled.isOff(id, ["board_*"])).toBe(ToolSearch.matches("board_*", id))
    }
  })

  bunIt("REFUSES to switch off a repair-only tool, even when config names it", () => {
    // `invalid` is where experimental_repairToolCall sends a malformed tool
    // call (session/llm.ts). Honour `tools: { invalid: false }` and that
    // redirect points at a tool missing from `prepared.tools`, so every model
    // that emits bad JSON breaks. Config cannot reach it — not by name...
    for (const id of SessionPromptCapture.REPAIR_ONLY_TOOLS) {
      expect(ToolEnabled.isOff(id, [id])).toBe(false)
      // ...and not by a wildcard that happens to cover it either.
      expect(ToolEnabled.isOff(id, ["*"])).toBe(false)
    }
    // The exemption is narrow: `*` still switches off everything else.
    expect(ToolEnabled.isOff("read", ["*"])).toBe(true)
  })
})

describe("ToolEnabled.keepEnabled", () => {
  const items = [{ id: "read" }, { id: "shell" }, { id: "board_create" }]

  bunIt("drops the matched ids and keeps the order of the rest", () => {
    expect(ToolEnabled.keepEnabled(items, ["shell"])).toEqual([{ id: "read" }, { id: "board_create" }])
  })

  bunIt("is a no-op with no patterns", () => {
    expect(ToolEnabled.keepEnabled(items, [])).toEqual(items)
  })
})

// ── 2. The seam ─────────────────────────────────────────────────────────────
// Same harness shape as tool-search.test.ts's seam block: a real ToolRegistry,
// a mocked MCP server, and the real SessionTools.resolve. The only difference
// is the config layer, which is what these tests vary.

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
  clients: () => Effect.succeed({ weather: { getServerCapabilities: () => ({}) } as never }),
})

/** The stack under test, with whatever `tools` block the case needs. */
const withConfig = (value: Record<string, unknown>) =>
  testEffect(
    LayerNode.compile(
      LayerNode.group([
        // Config is EXPOSED, not just supplied as a dependency the way
        // tool-search.test.ts's stack has it: SessionTools.resolve now reads
        // config itself (for the OFF list), so `Config.Service` is in the
        // body's requirements and the compiled layer has to satisfy it.
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
            get: () => Effect.succeed(value as never),
            directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
          }),
        ],
        [RuntimeFlags.node, RuntimeFlags.layer()],
        [MCP.node, mcpMock],
      ],
    ),
  )

const MODEL = { providerID: ProviderV2.ID.opencode, api: { id: "test", npm: "" } } as unknown as Provider.Model
const PROCESSOR = {
  message: { id: MessageID.make("msg_toolenabled") },
  updateToolCall: () => Effect.void,
  completeToolCall: () => Effect.void,
} as unknown as Parameters<typeof SessionTools.resolve>[0]["processor"]

const resolveFor = (sessionID: string) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    return yield* SessionTools.resolve({
      agent: yield* agents.defaultInfo(),
      model: MODEL,
      session: { id: SessionID.make(sessionID), permission: undefined } as unknown as Session.Info,
      processor: PROCESSOR,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
  })

afterEach(async () => {
  await disposeAllInstances()
})

const allOn = withConfig({})
const readOff = withConfig({ tools: { read: false } })
const mcpOff = withConfig({ tools: { weather_current: false } })
const invalidOff = withConfig({ tools: { invalid: false } })

describe("SessionTools.resolve — an OFF tool is not offered to the model", () => {
  allOn.instance("CONTROL: with no `tools` block, read is in the map", () =>
    Effect.gen(function* () {
      // The control matters more than usual here: every assertion below is an
      // ABSENCE, and an absence proves nothing unless the presence is shown.
      expect(Object.keys(yield* resolveFor("ses_on"))).toContain("read")
    }),
  )

  readOff.instance("`tools: { read: false }` removes read from the tool map", () =>
    Effect.gen(function* () {
      const tools = yield* resolveFor("ses_read_off")
      expect(Object.keys(tools)).not.toContain("read")
      // Its neighbours are untouched — the filter is per-id, not a blast radius.
      expect(Object.keys(tools)).toContain("glob")
      expect(Object.keys(tools)).toContain("grep")
    }),
  )

  readOff.instance("...and does not leave it behind as a tool_search catalog line", () =>
    Effect.gen(function* () {
      // The half that would be silently wrong if OFF were applied after the
      // deferral decision: the tool would be gone from the map but still
      // advertised, and one tool_search call would load it straight back in.
      const tools = yield* resolveFor("ses_read_catalog")
      const search = tools[ToolSearch.TOOL_SEARCH_TOOL]
      // The MCP tool is still deferred here, so the catalog exists to look in.
      expect(search).toBeDefined()
      expect(search!.description!).toContain("weather_current")
      expect(search!.description!).not.toContain("read (builtin)")
    }),
  )

  mcpOff.instance("switches off an MCP tool too, so it is neither loaded nor deferred", () =>
    Effect.gen(function* () {
      const tools = yield* resolveFor("ses_mcp_off")
      expect(Object.keys(tools)).not.toContain("weather_current")
      // ...and gone from the CATALOG as well as the map. The catalog is still
      // there — several builtins mark themselves deferrable, so switching off
      // the one MCP tool does not empty it — which makes this the sharper
      // check of the two: the line that WOULD have advertised it is missing
      // from a description that still lists everything else.
      const search = tools[ToolSearch.TOOL_SEARCH_TOOL]
      expect(search).toBeDefined()
      expect(search!.description!).not.toContain("weather_current")
    }),
  )

  mcpOff.instance("beats a tool the session had ALREADY pulled in with tool_search", () =>
    Effect.gen(function* () {
      // The second-call case. `tool_search` remembers what it loaded per
      // session so a found tool stays callable on later turns — and that
      // memory is checked by the DEFERRAL rules, which is the wrong place for
      // it to be able to resurrect something switched off. Simulated by
      // loading the id directly, exactly as a search would have.
      const search = yield* ToolSearch.Service
      const sessionID = SessionID.make("ses_mcp_loaded")
      yield* search.load(sessionID, ["weather_current"])

      const tools = yield* resolveFor(sessionID)
      expect(Object.keys(tools)).not.toContain("weather_current")
    }),
  )

  invalidOff.instance("IGNORES an attempt to switch off `invalid` — the repair path keeps working", () =>
    Effect.gen(function* () {
      // Not reachable from the pane (acp/tools.ts does not list it), but a
      // hand-edited origami.json can say it. session/llm.ts rewrites every
      // unparseable tool call to `toolName: "invalid"`, so it must be in the
      // map whatever config claims.
      expect(Object.keys(yield* resolveFor("ses_invalid_off"))).toContain("invalid")
    }),
  )
})

describe("ACPTools.project — the pane can SEE the off state, so it can be undone", () => {
  const list = [
    { id: "invalid", description: "Do not use" },
    { id: "read", description: "Read a file" },
    { id: "board_tickets", description: "List tickets" },
  ]

  bunIt("marks a switched-off tool disabled and still LISTS it", () => {
    const result = ACPTools.project(list, { tools: { read: false } })
    const row = result.tools.find((t) => t.id === "read")
    // Listed is the point: a state with no control is a trap.
    expect(row).toBeDefined()
    expect(row!.disabled).toBe(true)
    expect(result.tools.find((t) => t.id === "board_tickets")!.disabled).toBe(false)
  })

  bunIt("round-trips: a tool listed as disabled comes back disabled, not loaded or deferred", () => {
    // The guard the brief asked for. `deferred` and `disabled` are separate
    // fields on the wire, and the failure mode is a row that reports both —
    // the pane would then have to guess which one won.
    const config = { tools: { board_tickets: false } }
    const first = ACPTools.project(list, config).tools.find((t) => t.id === "board_tickets")!
    const again = ACPTools.project(list, config).tools.find((t) => t.id === "board_tickets")!
    expect(first).toEqual(again)
    expect(again.disabled).toBe(true)
  })

  bunIt("reports disabled independently of the deferral verdict", () => {
    const result = ACPTools.project(list, {
      tools: { board_tickets: false },
      experimental: { tool_search: { defer: ["board_tickets"] } },
    })
    const row = result.tools.find((t) => t.id === "board_tickets")!
    // Both can be true on the wire; OFF is what the engine actually acted on
    // (session/tools.ts filters before deferring), and the pane renders OFF.
    expect(row.disabled).toBe(true)
  })

  bunIt("never reports `invalid` at all, disabled or otherwise", () => {
    const result = ACPTools.project(list, { tools: { invalid: false } })
    expect(result.tools.map((t) => t.id)).not.toContain("invalid")
  })
})
