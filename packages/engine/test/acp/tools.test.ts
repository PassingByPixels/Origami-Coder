// acp/tools.ts — the `list_tools` ext method the Tools pane reads.
//
// `project()` is pure (no engine, no Effect service) and is exercised as
// plain unit tests here: given a tool list + config + an optional source/
// location map, does it compute the right `deferred`, `source` and
// `hardRequired` verdicts. `meta()` is the one impure read (a live registry),
// covered separately with a real ToolRegistry.node boot, the same pattern
// test/tool/registry.test.ts already uses.
//
// The REPAIR_ONLY_TOOLS tests ARE the drift guard t-kgtaac round 3 asked for,
// now pointed at the opposite verdict: `project()` reads
// `SessionPromptCapture.REPAIR_ONLY_TOOLS` (session/prompt-capture.ts, the
// actual set `experimental_repairToolCall` hard-codes `toolName: "invalid"`
// against — session/llm.ts:347) and DROPS its members from the catalog
// instead of listing them with a disabled toggle. The set is read, never
// re-typed, so a future member is dropped by the same line; the tests prove
// the WIRING — that the pane can never be handed an engine-internal tool.

import { afterEach, describe, expect, it } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ACPTools } from "@/acp/tools"
import { SessionPromptCapture } from "@/session/prompt-capture"

describe("ACPTools.project (pure)", () => {
  const list = [
    { id: "invalid", description: "Do not use" },
    { id: "read", description: "Read a file" },
    { id: "board_tickets", description: "List tickets" },
  ]

  it("drops every REPAIR_ONLY_TOOLS member from the catalog", () => {
    const result = ACPTools.project(list, undefined)
    const ids = result.tools.map((t) => t.id)
    // `invalid` is engine machinery, not a tool a user can load, defer or
    // switch off — it must never be a card. Asserted against the SET rather
    // than the literal so a future member is covered by the same test...
    for (const repairOnly of SessionPromptCapture.REPAIR_ONLY_TOOLS) {
      expect(ids).not.toContain(repairOnly)
    }
    // ...and against the literal too, so the test still fails loudly if the
    // set itself is ever emptied and the filter silently stops doing anything.
    expect(SessionPromptCapture.REPAIR_ONLY_TOOLS.has("invalid")).toBe(true)
    expect(ids).not.toContain("invalid")
    // Everything else survives untouched.
    expect(ids).toEqual(["board_tickets", "read"])
  })

  it("leaves hardRequired false for every row it does emit", () => {
    // The verdict is now vestigial ENGINE-side by construction: the only rows
    // that could carry it are the ones the filter removes. It stays in the
    // payload for the shell's synthetic `tool_search` card, which sets its own.
    const result = ACPTools.project(list, undefined)
    expect(result.tools.every((t) => t.hardRequired === false)).toBe(true)
  })

  it("defaults every row to source builtin when no meta map is given", () => {
    const result = ACPTools.project(list, undefined)
    expect(result.tools.every((t) => t.source === "builtin")).toBe(true)
    expect(result.tools.every((t) => t.location === undefined)).toBe(true)
  })

  it("carries source and location through from the meta map, by id", () => {
    const meta = new Map<string, ACPTools.ToolMeta>([
      ["board_tickets", { source: "user-file", location: "/ws/.origami/tool/board_tickets.ts" }],
    ])
    const result = ACPTools.project(list, undefined, meta)
    const row = result.tools.find((t) => t.id === "board_tickets")
    expect(row?.source).toBe("user-file")
    expect(row?.location).toBe("/ws/.origami/tool/board_tickets.ts")
    // Untouched rows still default correctly.
    expect(result.tools.find((t) => t.id === "read")?.source).toBe("builtin")
  })

  it("still computes the existing deferred verdict unaffected by the new fields", () => {
    const result = ACPTools.project(list, {
      experimental: { tool_search: { enabled: true, mcp: true, defer: ["board_tickets"], always: [] } },
    })
    expect(result.tools.find((t) => t.id === "board_tickets")?.deferred).toBe(true)
    expect(result.tools.find((t) => t.id === "read")?.deferred).toBe(false)
    // tool_search itself is never in this list (it's synthesized elsewhere),
    // and "invalid" never reaches the deferral rules at all now — it is
    // filtered out before `ToolSearch.deferred` is asked anything, so it can
    // neither be deferred nor appear as a catalog line.
  })
})

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
})
const it2 = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("ACPTools.meta (live registry)", () => {
  it2.instance("reads a user-file tool's location off the live registry", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".origami", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      const helloPath = path.join(tool, "hello.ts")
      yield* Effect.promise(() =>
        Bun.write(
          helloPath,
          ["export default {", "  description: 'hi',", "  args: {},", "  execute: async () => 'hi',", "}", ""].join(
            "\n",
          ),
        ),
      )

      const map = yield* ACPTools.meta()
      expect(map.get("hello")).toEqual({ source: "user-file", location: helloPath })
      expect(map.get("read")).toEqual({ source: "builtin" })
    }),
  )
})

// A user tool file the registry could not load reaches the pane as a SIBLING
// of `tools`, never as a row — it produced no tool, so it has no id, no
// description and no state to set. This is the last hop of the containment
// fix: the engine already skips the file (test/tool/registry.test.ts), and
// what makes the skip visible is that this projection carries it.
describe("acp.tools problems", () => {
  const rows = [{ id: "read", description: "Read a file" }]

  it("carries problems through, sorted by file, without touching the rows", () => {
    const result = ACPTools.project(rows, {}, new Map(), [
      { file: "/ws/.origami/tool/zebra.ts", message: "boom" },
      { file: "/ws/.origami/tool/alpha.ts", message: "Cannot find module '@origami/plugin'" },
    ])

    expect(result.problems.map((p) => p.file)).toEqual(["/ws/.origami/tool/alpha.ts", "/ws/.origami/tool/zebra.ts"])
    // THE PATH IS NOT REDACTED. It is the user's own file, and the redacted
    // "Origami service failure" is precisely what made this class of failure
    // undiagnosable from the client.
    expect(result.problems[0]!.message).toContain("@origami/plugin")
    expect(result.tools.map((t) => t.id)).toEqual(["read"])
  })

  it("answers an empty list when every user tool loaded", () => {
    expect(ACPTools.project(rows, {}).problems).toEqual([])
  })

  // `config.directories()` can name the same folder twice, so the same bad file
  // can be reported twice. The pane keys its `{#each}` on `file`, where a
  // repeat is a RUNTIME ERROR — the fix would break the pane it exists to save.
  it("reports one repeated bad file once", () => {
    const twice = [
      { file: "/ws/.origami/tool/ticket.ts", message: "Cannot find module '@origami/plugin'" },
      { file: "/ws/.origami/tool/ticket.ts", message: "Cannot find module '@origami/plugin'" },
    ]

    expect(ACPTools.project(rows, {}, new Map(), twice).problems).toHaveLength(1)
  })

  it2.instance("reads a broken user tool file off the live registry", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, ".origami", "tool")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      const broken = path.join(dir, "ticket.ts")
      yield* Effect.promise(() =>
        Bun.write(
          broken,
          [
            'import { tool } from "@origami/plugin"',
            "export default tool({ description: 'x', args: {}, execute: async () => 'x' })",
            "",
          ].join("\n"),
        ),
      )

      const found = yield* ACPTools.problems()
      expect(found).toHaveLength(1)
      expect(found[0]!.file).toBe(broken)
      expect(found[0]!.message).toContain("@origami/plugin")
    }),
  )
})
