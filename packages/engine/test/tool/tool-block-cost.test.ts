import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolSearch } from "@/tool/tool-search"
import { SessionTools } from "@/session/tools"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Truncate } from "@/tool/truncate"
import { MCP } from "@/mcp"
import type { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { asSchema } from "ai"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

/**
 * THE TOOL BLOCK, MEASURED PER AGENT.
 *
 * Item 2.2 of the token-burn plan is judged by one number: how many bytes of
 * tool descriptions and JSON Schemas the engine declares on EVERY model call,
 * per agent. This drives the real `SessionTools.resolve` (the function the
 * agent loop calls once per step) and then applies the request layer's own
 * cage filter (`Permission.disabled`, `session/llm/request.ts:294`), so the
 * bytes printed here are the bytes that reach the wire — not a proxy.
 *
 * It prints a markdown table rather than asserting a byte budget: the number
 * moves whenever a tool description is edited, and a test that failed on that
 * would be a tax on every unrelated change. The assertions pin the invariants
 * that must hold whatever the bytes are.
 */

/**
 * `scout` and `cartographer` are not engine natives: the VS Code dashboard
 * writes them as `.origami/agent/*.md` files
 * (packages/vscode/src/dashboard/agentManager/archetypes.ts:230-262). Their
 * frontmatter is parsed into exactly this `agent` config block and takes the
 * same `Permission.merge(defaults, fromConfig(...), user)` path in
 * `agent/agent.ts:500-538`, so declaring them here measures the real cage
 * rather than a file-scanner round trip.
 */
const ARCHETYPE_AGENTS = {
  scout: {
    description: "Read-only recon subagent.",
    mode: "subagent" as const,
    permission: {
      "*": "deny" as const,
      read: "allow" as const,
      grep: "allow" as const,
      glob: "allow" as const,
      list: "allow" as const,
      webfetch: "allow" as const,
      websearch: "allow" as const,
      bash: "deny" as const,
    },
  },
  cartographer: {
    description: "Maps the repository.",
    mode: "all" as const,
    permission: {
      "*": "deny" as const,
      read: "allow" as const,
      grep: "allow" as const,
      glob: "allow" as const,
      list: "allow" as const,
      question: "allow" as const,
      bash: "deny" as const,
      task: { "*": "deny" as const, scout: "allow" as const },
      edit: { "*": "deny" as const, ".origami/map/*": "allow" as const },
    },
  },
}

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
  get: () => Effect.succeed({ agent: ARCHETYPE_AGENTS } as never),
})

// No MCP server: this measures the BUILTIN block, which is what item 2.2 is
// about. A live server would add its own tools and make the table depend on
// whatever happened to be connected.
const mcpMock = Layer.mock(MCP.Service, {
  tools: () => Effect.succeed({}),
  clients: () => Effect.succeed({}),
})

const withEngine = testEffect(
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
      [MCP.node, mcpMock],
    ],
  ),
)

const MODEL = { providerID: ProviderV2.ID.opencode, api: { id: "test", npm: "" } } as unknown as Provider.Model
const PROCESSOR = {
  message: { id: MessageID.make("msg_toolcost") },
  updateToolCall: () => Effect.void,
  completeToolCall: () => Effect.void,
} as unknown as Parameters<typeof SessionTools.resolve>[0]["processor"]

const AGENTS = ["build", "general", "explore", "scout", "plan", "cartographer"] as const

const CHARS_PER_TOKEN = 3.2

type Row = {
  agent: string
  tools: number
  descriptionBytes: number
  schemaBytes: number
  catalogBytes: number
  deferred: number
  total: number
  /** Catalogued ids this agent is NOT allowed to execute. */
  forbidden: string[]
}

/**
 * What the request layer actually declares for one agent: `SessionTools.resolve`
 * for the map, then the same `Permission.disabled` filter `resolveTools` runs
 * before the call goes out.
 */
const measure = (agent: Agent.Info, index: number) =>
  Effect.gen(function* () {
    const session = {
      id: SessionID.make(`ses_cost_${index}`),
      permission: undefined,
    } as unknown as Session.Info
    const resolved = yield* SessionTools.resolve({
      agent,
      model: MODEL,
      session,
      processor: PROCESSOR,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const cage = agent.permission
    const disabled = Permission.disabled(Object.keys(resolved), cage)
    const declared = Object.entries(resolved).filter(
      ([id]) => id === ToolSearch.TOOL_SEARCH_TOOL || !disabled.has(id),
    )

    let descriptionBytes = 0
    let schemaBytes = 0
    let catalogBytes = 0
    let deferred = 0
    let catalogued: string[] = []
    for (const [id, def] of declared) {
      const description = def.description ?? ""
      const schema = JSON.stringify(asSchema(def.inputSchema).jsonSchema)
      if (id === ToolSearch.TOOL_SEARCH_TOOL) {
        catalogBytes = description.length + schema.length
        catalogued = description
          .split("\n")
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2).split(" ")[0] ?? "")
        deferred = catalogued.length
        continue
      }
      descriptionBytes += description.length
      schemaBytes += schema.length
    }

    return {
      agent: agent.name,
      tools: declared.length,
      descriptionBytes,
      schemaBytes,
      catalogBytes,
      deferred,
      total: descriptionBytes + schemaBytes + catalogBytes,
      // The point of the per-agent trim: a catalog line for a tool the cage
      // denies is a tool the model can find, pay a search for, and then never
      // be allowed to call. This must always come out empty.
      forbidden: [...Permission.disabled(catalogued, cage)],
    } satisfies Row
  })

const table = (rows: readonly Row[]) =>
  [
    "| agent | declared tools | deferred | description B | schema B | tool_search catalog B | total B | ~tokens |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((row) =>
      [
        "",
        row.agent,
        row.tools,
        row.deferred,
        row.descriptionBytes,
        row.schemaBytes,
        row.catalogBytes,
        row.total,
        Math.round(row.total / CHARS_PER_TOKEN),
        "",
      ].join(" | "),
    ),
  ].join("\n")

describe("tool block cost per agent", () => {
  withEngine.instance(
    "prints the declared description + schema bytes for each agent",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const rows: Row[] = []
        for (const [index, name] of AGENTS.entries()) {
          rows.push(yield* measure(yield* agents.get(name), index))
        }

        console.log(`\n${table(rows)}\n`)

        // Which tools the default agent hid, and what each of them cost when it
        // was declared in full. This is the line-by-line evidence behind the
        // table's "deferred" column - a reviewer arguing that one of these
        // belongs in CORE needs its price.
        const registry = yield* ToolRegistry.Service
        const full = yield* registry.tools({
          providerID: MODEL.providerID,
          modelID: ModelV2.ID.make("test"),
          agent: yield* agents.get("build"),
        })
        const hidden = new Set(
          ToolSearch.deferred(
            full.map((item) => ({
              id: item.id,
              kind: "builtin" as const,
              ...(item.deferrable ? { deferrable: true } : {}),
            })),
            ToolSearch.settings(),
          ),
        )
        console.log(
          [
            "deferred builtins for `build`, by the bytes they used to cost:",
            ...full
              .filter((item) => hidden.has(item.id))
              .map((item) => ({
                id: item.id,
                bytes: item.description.length + JSON.stringify(ToolJsonSchema.fromTool(item)).length,
              }))
              .sort((a, b) => b.bytes - a.bytes)
              .map((item) => `  ${String(item.bytes).padStart(6)}  ${item.id}`),
          ].join("\n"),
        )
        const out = process.env["TOOL_BLOCK_COST_OUT"]
        if (out) yield* Effect.promise(() => fs.writeFile(out, table(rows) + "\n", "utf8"))

        // Invariants, not a byte budget. These hold before and after the
        // deferral widening, so this file is a measurement harness that is
        // still a real test.
        for (const row of rows) {
          // Every agent can still do SOMETHING: a cage that produced an empty
          // tool list would be a turn the model cannot act in at all.
          expect(row.tools).toBeGreaterThan(0)
          expect(row.total).toBeGreaterThan(0)
          expect(row.forbidden, `${row.agent} is offered a catalog line it can never call`).toEqual([])
        }
        // The caged agents must not carry more than the uncaged default one.
        const build = rows.find((row) => row.agent === "build")!
        for (const name of ["explore", "scout", "cartographer"]) {
          expect(rows.find((row) => row.agent === name)!.total).toBeLessThan(build.total)
        }
      }),
    60000,
  )
})
