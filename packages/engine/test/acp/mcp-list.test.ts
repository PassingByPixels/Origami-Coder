import { describe, expect } from "bun:test"
import path from "path"
import { readFile } from "fs/promises"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { parse as parseJsonc } from "jsonc-parser"
import { AgentPlugins } from "@/agent-plugins"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { ACPMcp } from "@/acp/mcp"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * `ACPMcp.list` and `ACPMcp.setEnabled` against a REAL instance.
 *
 * `project` is unit-tested in mcp.test.ts; what needs an instance is the part
 * that cannot be reasoned about from the projection alone — that the pane's
 * `auth` field is really wired to `MCP.getAuthStatus` (and asked only for the
 * remote rows), and that the enable/disable toggle drives the live client, not
 * just the config file.
 */

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(MCP.node),
    LayerNode.compile(Config.node),
    LayerNode.compile(AgentPlugins.node),
    LayerNode.compile(CrossSpawnSpawner.node),
  ),
)

const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")
const localServer = { type: "local" as const, command: [process.execPath, stdioFixture] }
const remoteServer = { type: "remote" as const, url: "https://example.invalid/mcp" }

const rowFor = (result: ACPMcp.ListResult, name: string) => result.servers.find((s) => s.name === name)

describe("ACPMcp.list — against a live instance", () => {
  it.instance(
    "reports every configured server, with credential state on the REMOTE one only",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const result = yield* ACPMcp.list(test.directory)

        expect(result.servers.map((s) => s.name)).toEqual(["listed-local", "listed-remote"])
        // Never authenticated, and the field is PRESENT — the pane branches on
        // it to decide whether to offer "Forget login".
        expect(rowFor(result, "listed-remote")!.auth).toBe("not_authenticated")
        // A local server has no credential to have a state for; asking would
        // put a meaningless "not_authenticated" on every stdio row.
        expect(rowFor(result, "listed-local")!.auth).toBeUndefined()
        expect(rowFor(result, "listed-remote")!.supportsOAuth).toBe(true)
        expect(rowFor(result, "listed-local")!.supportsOAuth).toBe(false)
      }),
    { config: { mcp: { "listed-local": localServer, "listed-remote": remoteServer } } },
  )

  it.instance(
    "sources a config-declared server to `config` and marks nothing shadowed when no plugin owns the name",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const result = yield* ACPMcp.list(test.directory)

        expect(rowFor(result, "listed-local")).toMatchObject({ source: "config", shadowed: false, type: "local" })
      }),
    { config: { mcp: { "listed-local": localServer } } },
  )

  it.instance(
    "carries the LIVE status, not a config-derived guess",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // Connect it for real first, then ask.
        yield* MCP.Service.use((mcp) => mcp.status())

        const result = yield* ACPMcp.list(test.directory)

        expect(rowFor(result, "listed-local")!.status).toMatchObject({ status: "connected" })
      }),
    { config: { mcp: { "listed-local": localServer } } },
  )

  it.instance(
    "lists a bare `{ enabled: false }` entry rather than dropping the one row a user needs to undo",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const result = yield* ACPMcp.list(test.directory)

        // The engine SKIPS this entry (no `type`), so it has no live status and
        // would be invisible if the pane listed only what MCP.status() knows.
        expect(rowFor(result, "marker-only")).toMatchObject({ type: "unknown", enabled: false, source: "config" })
      }),
    { config: { mcp: { "marker-only": { enabled: false } } } },
  )
})

describe("ACPMcp.setEnabled — config AND the live client", () => {
  it.instance(
    "disabling writes `enabled: false` AND takes the running client down",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* MCP.Service.use((mcp) => mcp.status())
        expect(yield* MCP.Service.use((mcp) => mcp.status())).toMatchObject({
          "toggle-me": { status: "connected" },
        })

        const result = yield* ACPMcp.setEnabled(test.directory, "toggle-me", false)

        expect(result.ok, result.ok ? "" : result.message).toBe(true)
        if (!result.ok) return
        // Config half.
        const written = parseJsonc(yield* Effect.promise(() => readFile(result.path!, "utf8")))
        expect(written.mcp["toggle-me"].enabled).toBe(false)
        // Runtime half — a config-only toggle would leave it connected until a restart.
        expect(result.status).toEqual({ status: "disabled" })
        expect((yield* MCP.Service.use((mcp) => mcp.status()))["toggle-me"]).toEqual({ status: "disabled" })
      }),
    { config: { mcp: { "toggle-me": localServer } } },
  )

  it.instance(
    "re-enabling clears `enabled: false` AND brings the client back up",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* MCP.Service.use((mcp) => mcp.status())
        yield* ACPMcp.setEnabled(test.directory, "toggle-me", false)

        const result = yield* ACPMcp.setEnabled(test.directory, "toggle-me", true)

        expect(result.ok, result.ok ? "" : result.message).toBe(true)
        if (!result.ok) return
        const written = parseJsonc(yield* Effect.promise(() => readFile(result.path!, "utf8")))
        expect(written.mcp["toggle-me"].enabled).toBe(true)
        expect(result.status).toMatchObject({ status: "connected" })
      }),
    { config: { mcp: { "toggle-me": localServer } } },
  )
})
