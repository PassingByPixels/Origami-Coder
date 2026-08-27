import { describe, expect } from "bun:test"
import path from "path"
import { readFile } from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { parse as parseJsonc } from "jsonc-parser"
import { MCP } from "@/mcp"
import { ACPMcp } from "@/acp/mcp"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * `ACPMcp.add` — the pane's "add a server" button, end to end.
 *
 * The acceptance line this covers is the one the design turns on: `MCP.add`
 * (mcp/index.ts) is IN-MEMORY ONLY, and a config write alone does nothing
 * until the session restarts. A UI add must do BOTH, so both halves are
 * asserted from their own evidence — the file on disk for the persistence
 * half, a `connected` status from a REAL stdio server for the runtime half.
 * Asserting only the returned object would pass with either half missing.
 *
 * Only `scope: "project"` is exercised. `"global"` writes to
 * `Global.Path.config`, which is the real user's config on whatever machine
 * runs this suite — not a thing a test may touch.
 */

const it = testEffect(LayerNode.compile(MCP.node))
const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")
const workingServer = { type: "local", command: [process.execPath, stdioFixture] }

const configOf = async (directory: string) =>
  parseJsonc(await readFile(path.join(directory, "origami.json"), "utf8")) as Record<string, any>

const fileExists = (file: string) =>
  readFile(file, "utf8").then(
    () => true,
    () => false,
  )

describe("ACPMcp.add — persists AND connects", () => {
  it.instance("writes the server to the project config file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      const result = yield* ACPMcp.add(test.directory, "added-stdio", workingServer, "project")

      expect(result.ok, result.ok ? "" : result.message).toBe(true)
      if (!result.ok) return
      expect(result.path).toBe(path.join(test.directory, "origami.json"))
      expect((yield* Effect.promise(() => configOf(test.directory))).mcp["added-stdio"]).toEqual(workingServer)
    }),
  )

  it.instance("connects the server IMMEDIATELY — no session restart", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // WARM THE STATE FIRST, and this is the whole point of the test. MCP's
      // InstanceState is built lazily and its builder connects everything the
      // config names — so with a COLD instance a config-only add would connect
      // by accident on the next read, and this test would pass with the
      // runtime `MCP.add` deleted (verified: it did). A live session has
      // already built that state, so warming it here is what makes the
      // assertion below actually about `MCP.add`.
      yield* MCP.Service.use((mcp) => mcp.status())

      const result = yield* ACPMcp.add(test.directory, "added-live", workingServer, "project")

      expect(result.ok, result.ok ? "" : result.message).toBe(true)
      if (!result.ok) return
      // `disabled` is what a CONFIG-ONLY add would report (mcp/index.ts's
      // status() falls back to disabled for a name it knows but never
      // created). `connected` can only come from the runtime MCP.add.
      expect(result.status).toMatchObject({ status: "connected" })
      // ...and the engine's own status map agrees, not just the return value.
      const status = yield* MCP.Service.use((mcp) => mcp.status())
      expect(status["added-live"]).toMatchObject({ status: "connected" })
    }),
  )

  it.instance("makes the new server's tools reachable in the SAME session", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      yield* MCP.Service.use((mcp) => mcp.status())

      yield* ACPMcp.add(test.directory, "added-tools", workingServer, "project")

      // The point of connecting now: the model can call it without a restart.
      const tools = Object.keys(yield* MCP.Service.use((mcp) => mcp.tools()))
      expect(tools.some((name) => name.startsWith("added-tools_"))).toBe(true)
    }),
  )
})

describe("ACPMcp.add — refusals never reach the filesystem", () => {
  it.instance("rejects a shape the config schema does not accept, and writes nothing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      // `local` requires `command`; the schema is the SAME one the config
      // loader uses, so this is refused for the same reason a hand-edited
      // config would be.
      const result = yield* ACPMcp.add(test.directory, "bad-shape", { type: "local" }, "project")

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain("bad-shape")
      expect(result.message).toContain("not a valid MCP server")
      expect(yield* Effect.promise(() => fileExists(path.join(test.directory, "origami.json")))).toBe(false)
    }),
  )

  it.instance("rejects an unknown transport type", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      const result = yield* ACPMcp.add(test.directory, "bad-type", { type: "carrier-pigeon" }, "project")

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain("not a valid MCP server")
    }),
  )

  it.instance("rejects a blank name before it can write an unaddressable `mcp[\"\"]` entry", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      const result = yield* ACPMcp.add(test.directory, "   ", workingServer, "project")

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain("name is required")
      expect(yield* Effect.promise(() => fileExists(path.join(test.directory, "origami.json")))).toBe(false)
    }),
  )

  it.instance("refuses a name already in the config instead of adding a second entry", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      const first = yield* ACPMcp.add(test.directory, "added-twice", workingServer, "project")
      expect(first.ok, first.ok ? "" : first.message).toBe(true)

      const second = yield* ACPMcp.add(test.directory, "added-twice", workingServer, "project")

      expect(second.ok).toBe(false)
      if (second.ok) return
      expect(second.message).toContain("already configured")
      expect(Object.keys((yield* Effect.promise(() => configOf(test.directory))).mcp)).toEqual(["added-twice"])
    }),
  )
})

describe("ACPMcp.remove — takes the entry off disk and the client down", () => {
  it.instance("deletes the config entry and disconnects the live client", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* MCP.Service.use((mcp) => mcp.status())
      yield* ACPMcp.add(test.directory, "added-then-removed", workingServer, "project")
      expect(yield* MCP.Service.use((mcp) => mcp.status())).toMatchObject({
        "added-then-removed": { status: "connected" },
      })

      const result = yield* ACPMcp.remove(test.directory, "added-then-removed")

      expect(result.ok, result.ok ? "" : result.message).toBe(true)
      const mcp = (yield* Effect.promise(() => configOf(test.directory))).mcp ?? {}
      expect(Object.keys(mcp)).not.toContain("added-then-removed")
      expect((yield* MCP.Service.use((m) => m.status()))["added-then-removed"]).toEqual({ status: "disabled" })
    }),
  )

  it.instance("refuses a name no config file holds, with the writer's own message", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      const result = yield* ACPMcp.remove(test.directory, "never-configured-anywhere")

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain("is not in mcp in any")
    }),
  )
})
