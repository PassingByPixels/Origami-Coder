import { describe, expect, test } from "bun:test"
import type { ConfigMCPV1 } from "@origami/core/v1/config/mcp"
import type { MCP } from "@/mcp"
import { ACPMcp } from "@/acp/mcp"

/**
 * `ACPMcp.project` — the pure merge behind the MCP pane's list.
 *
 * The regression it exists for is `mcp/index.ts`'s state builder:
 * `{ ...pluginServers, ...cfg.mcp }`. A user's own `mcp` entry SHADOWS a
 * plugin-provided server of the same name, silently. A row that does not say
 * so turns "I disabled it and it is still running" into an unexplainable bug
 * report, so `source` and `shadowed` are asserted per row here rather than
 * left to the pane.
 *
 * The second rule is the bare `{ enabled: false }` entry: legal config (core
 * `config.ts`), SKIPPED by the engine because it has no `type`, and the only
 * way to turn off a plugin's server. Dropping it from the list would leave a
 * user unable to undo their own disable.
 */

const local = (cmd: string): ConfigMCPV1.Info => ({ type: "local", command: [cmd] })
const remote = (url: string, oauth?: ConfigMCPV1.Info extends never ? never : false): ConfigMCPV1.Info =>
  oauth === false ? { type: "remote", url, oauth: false } : { type: "remote", url }

describe("ACPMcp.project — where a server came from", () => {
  test("a config entry SHADOWS a plugin server of the same name, and the row says so", () => {
    const rows = ACPMcp.project(
      { shared: local("mine") },
      { shared: local("theirs") },
      { shared: { status: "connected" } },
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]!.source).toBe("config")
    expect(rows[0]!.shadowed).toBe(true)
    // The DEFINITION shown is the one the engine actually uses — cfg wins.
    expect(rows[0]!.command).toEqual(["mine"])
  })

  test("a plugin-only server is sourced to the plugin and is NOT marked shadowed", () => {
    const rows = ACPMcp.project({}, { theirs: local("theirs") }, {})

    expect(rows[0]).toMatchObject({ name: "theirs", source: "plugin", shadowed: false, type: "local" })
  })

  test("a config-only server is sourced to config and is NOT marked shadowed", () => {
    const rows = ACPMcp.project({ mine: local("mine") }, {}, {})

    expect(rows[0]).toMatchObject({ name: "mine", source: "config", shadowed: false })
  })

  test("every server appears exactly once, sorted by name", () => {
    const rows = ACPMcp.project({ zeta: local("z"), alpha: local("a") }, { alpha: local("a2"), mid: local("m") }, {})

    expect(rows.map((r) => r.name)).toEqual(["alpha", "mid", "zeta"])
  })
})

describe("ACPMcp.project — the bare `{ enabled: false }` disable marker", () => {
  test("is listed, typed `unknown`, and reported disabled rather than dropped", () => {
    // The ONLY way to turn off a plugin's server. The engine skips it (no
    // `type`), so it never appears in the status map either.
    const rows = ACPMcp.project({ theirs: { enabled: false } }, { theirs: local("theirs") }, {})

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: "theirs",
      source: "config",
      shadowed: true,
      type: "unknown",
      enabled: false,
    })
  })

  test("a marker for a name no plugin provides is still listed (a user can delete it)", () => {
    const rows = ACPMcp.project({ orphan: { enabled: false } }, {}, {})

    expect(rows[0]).toMatchObject({ name: "orphan", source: "config", shadowed: false, type: "unknown" })
  })
})

describe("ACPMcp.project — enabled and status", () => {
  test("`enabled: false` on a real server config reads as disabled", () => {
    const rows = ACPMcp.project({ off: { type: "local", command: ["x"], enabled: false } }, {}, {})

    expect(rows[0]!.enabled).toBe(false)
  })

  test("an absent `enabled` is enabled — never inverted by a missing field", () => {
    expect(ACPMcp.project({ on: local("x") }, {}, {})[0]!.enabled).toBe(true)
  })

  test("a failed server carries the engine's own error text, not a rewrite", () => {
    const status: Record<string, MCP.Status> = { bad: { status: "failed", error: "spawn ENOENT nope" } }

    expect(ACPMcp.project({ bad: local("nope") }, {}, status)[0]!.status).toEqual({
      status: "failed",
      error: "spawn ENOENT nope",
    })
  })

  test("a server absent from the status map reads disabled, never connected", () => {
    expect(ACPMcp.project({ never: local("x") }, {}, {})[0]!.status).toEqual({ status: "disabled" })
  })
})

describe("ACPMcp.project — which servers can be authenticated", () => {
  test("a remote server with no oauth block supports OAuth (auto-discovery)", () => {
    const rows = ACPMcp.project({ r: remote("https://example.test/mcp") }, {}, {})

    expect(rows[0]).toMatchObject({ type: "remote", url: "https://example.test/mcp", supportsOAuth: true })
  })

  test("`oauth: false` turns it off — the same rule MCP.supportsOAuth applies", () => {
    expect(ACPMcp.project({ r: remote("https://example.test/mcp", false) }, {}, {})[0]!.supportsOAuth).toBe(false)
  })

  test("a local server never supports OAuth, and carries its command instead of a url", () => {
    const row = ACPMcp.project({ l: { type: "local", command: ["npx", "srv"] } }, {}, {})[0]!

    expect(row.supportsOAuth).toBe(false)
    expect(row.url).toBeUndefined()
    expect(row.command).toEqual(["npx", "srv"])
  })

  test("a bare marker never supports OAuth (there is no server definition to ask)", () => {
    expect(ACPMcp.project({ m: { enabled: false } }, {}, {})[0]!.supportsOAuth).toBe(false)
  })
})
