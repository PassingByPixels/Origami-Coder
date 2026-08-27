import { describe, expect, test } from "bun:test"
import type { AgentPlugins } from "@/agent-plugins"
import type { MCP } from "@/mcp"
import { ACPAgentPlugins } from "@/acp/agent-plugins"

/**
 * `ACPAgentPlugins.project` — the pure projection from a loader `Entry` plus
 * the live `MCP.Service.status()` map to one Plugins-pane card.
 *
 * Regression: `MCP.Service.status()` is a single global map keyed by bare
 * server name. A disabled plugin's `mcp` field is the loader's raw DECLARED
 * map (index.ts's disabled branch never dedupes it against server
 * ownership), so a disabled plugin can declare a server name an unrelated
 * ENABLED plugin also declares and actually registers. Looking that name up
 * in the global map would then show the disabled plugin's card as running a
 * server it does not own and never will while disabled.
 */

function entry(name: string, enabled: boolean, mcp: AgentPlugins.Entry["mcp"]): AgentPlugins.Entry {
  return {
    spec: `./${name}`,
    root: `/plugins/${name}`,
    manifestPath: `/plugins/${name}/agent-plugin.json`,
    raw: {},
    name,
    mode: "strict",
    manifest: { name, skillPaths: [] },
    dataDir: `/data/${name}`,
    mcp,
    skillFiles: [],
    warnings: [],
    enabled,
  }
}

describe("ACPAgentPlugins.project", () => {
  test("a disabled plugin never reports a name-colliding enabled plugin's live status", () => {
    const disabled = entry("plugin-a", false, { foo: { type: "local", command: ["a"] } })
    // Global status map: "foo" IS connected — but it's plugin-b's "foo" (below), not plugin-a's.
    const status: Record<string, MCP.Status> = { foo: { status: "connected" } }

    const projected = ACPAgentPlugins.project(disabled, status)

    expect(projected.mcp).toEqual([{ name: "foo", type: "local", status: { status: "disabled" } }])
  })

  test("an enabled plugin's own registered server DOES report live status", () => {
    const enabled = entry("plugin-b", true, { foo: { type: "local", command: ["b"] } })
    const status: Record<string, MCP.Status> = { foo: { status: "connected" } }

    const projected = ACPAgentPlugins.project(enabled, status)

    expect(projected.mcp).toEqual([{ name: "foo", type: "local", status: { status: "connected" } }])
  })

  test("a plugin's server absent from the status map (never connected) still reports disabled", () => {
    const enabled = entry("plugin-c", true, { bar: { type: "remote", url: "https://example.test/mcp" } })

    const projected = ACPAgentPlugins.project(enabled, {})

    expect(projected.mcp).toEqual([{ name: "bar", type: "remote", status: { status: "disabled" } }])
  })
})
