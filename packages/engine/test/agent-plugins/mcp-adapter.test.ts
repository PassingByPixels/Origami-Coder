import { describe, expect, test } from "bun:test"
import path from "path"
import { AgentPluginMcp } from "@/agent-plugins/mcp-adapter"

const ROOT = path.resolve(import.meta.dir, "../fixture/agent-plugins/standard")
const DATA = path.resolve(import.meta.dir, "../fixture/agent-plugins/.data/standard")
const ctx = { name: "standard.fixture", root: ROOT, data: DATA }

describe("AgentPluginMcp.tokenize", () => {
  test("splits a bare command line", () => {
    expect(AgentPluginMcp.tokenize("npx -y some-server")).toEqual(["npx", "-y", "some-server"])
  })

  test("keeps a quoted executable path in one piece", () => {
    // The Windows case. Splitting on whitespace here yields "C:\Program" and
    // nothing spawns.
    expect(AgentPluginMcp.tokenize('"C:\\Program Files\\node\\node.exe" --flag')).toEqual([
      "C:\\Program Files\\node\\node.exe",
      "--flag",
    ])
  })

  test("keeps an empty quoted argument", () => {
    expect(AgentPluginMcp.tokenize('cmd "" x')).toEqual(["cmd", "", "x"])
  })
})

describe("AgentPluginMcp.adapt", () => {
  test("maps a declared stdio server to local, expanding both placeholders", () => {
    const { servers, warnings } = AgentPluginMcp.adapt(
      {
        s: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/server.js", "--state", "${PLUGIN_DATA}/state.json"],
          env: { FIXTURE: "1", ROOTED: "${PLUGIN_ROOT}" },
          cwd: "./skills",
        },
      },
      ctx,
    )
    expect(warnings).toEqual([])
    const info = servers["s"]!
    expect(info.type).toBe("local")
    if (info.type !== "local") return
    // Verbatim substitution, NOT path.join: an arg is a command-line string the
    // server parses itself, and rewriting separators inside one is not the
    // adapter's business. Forward slashes work on Windows too.
    expect(info.command).toEqual(["node", `${ROOT}/server.js`, "--state", `${DATA}/state.json`])
    expect(info.environment?.["FIXTURE"]).toBe("1")
    expect(info.environment?.["ROOTED"]).toBe(ROOT)
    // §4.1 env injection: every spawned server gets both, always.
    expect(info.environment?.["PLUGIN_ROOT"]).toBe(ROOT)
    expect(info.environment?.["PLUGIN_DATA"]).toBe(DATA)
    expect(info.cwd).toBe(path.join(ROOT, "skills"))
  })

  test("infers stdio for a Claude-format server with no type", () => {
    const { servers, warnings } = AgentPluginMcp.adapt(
      { blender: { command: "uvx", args: ["--from", "x", "y"], env: { QWEN_MM_AUTOLAUNCH: "1" } } },
      ctx,
    )
    expect(warnings).toEqual([])
    const info = servers["blender"]!
    expect(info.type).toBe("local")
    if (info.type !== "local") return
    expect(info.command).toEqual(["uvx", "--from", "x", "y"])
    expect(info.environment?.["QWEN_MM_AUTOLAUNCH"]).toBe("1")
  })

  test("splits command only when args is absent", () => {
    const split = AgentPluginMcp.adapt({ s: { command: "npx -y srv" } }, ctx).servers["s"]!
    expect(split.type === "local" && split.command).toEqual(["npx", "-y", "srv"])

    // With args present the author already split it, so a command containing a
    // space is a path and must survive intact.
    const kept = AgentPluginMcp.adapt({ s: { command: "C:\\Program Files\\x.exe", args: ["--a"] } }, ctx).servers["s"]!
    expect(kept.type === "local" && kept.command).toEqual(["C:\\Program Files\\x.exe", "--a"])
  })

  test("maps streamable-http and sse onto remote, keeping headers", () => {
    const { servers } = AgentPluginMcp.adapt(
      {
        a: { type: "streamable-http", url: "https://a.invalid/mcp", headers: { X: "1" } },
        b: { type: "sse", url: "https://b.invalid/sse" },
      },
      ctx,
    )
    expect(servers["a"]).toEqual({ type: "remote", url: "https://a.invalid/mcp", headers: { X: "1" } })
    expect(servers["b"]).toEqual({ type: "remote", url: "https://b.invalid/sse" })
  })

  test("infers remote from url when type is absent", () => {
    const { servers, warnings } = AgentPluginMcp.adapt({ s: { url: "https://c.invalid/mcp" } }, ctx)
    expect(warnings).toEqual([])
    expect(servers["s"]).toEqual({ type: "remote", url: "https://c.invalid/mcp" })
  })

  test("overrides a plugin that sets the reserved env names", () => {
    const { servers, warnings } = AgentPluginMcp.adapt(
      { s: { command: "node", env: { PLUGIN_ROOT: "/etc", PLUGIN_DATA: "/etc" } } },
      ctx,
    )
    const info = servers["s"]!
    expect(info.type === "local" && info.environment?.["PLUGIN_ROOT"]).toBe(ROOT)
    expect(info.type === "local" && info.environment?.["PLUGIN_DATA"]).toBe(DATA)
    expect(warnings.join(" ")).toContain("PLUGIN_ROOT")
    expect(warnings.join(" ")).toContain("PLUGIN_DATA")
  })

  test("refuses a server whose cwd escapes the plugin root", () => {
    const { servers, warnings } = AgentPluginMcp.adapt({ s: { command: "node", cwd: "../../../.." } }, ctx)
    expect(servers["s"]).toBeUndefined()
    expect(warnings.join(" ")).toContain("outside the plugin root")
  })

  test("refuses a shipped command that escapes the plugin root", () => {
    const { servers, warnings } = AgentPluginMcp.adapt({ s: { command: "./../../../../bin/sh" } }, ctx)
    expect(servers["s"]).toBeUndefined()
    expect(warnings.join(" ")).toContain("outside the plugin root")
  })

  test("skips an unusable server without losing its siblings", () => {
    const { servers, warnings } = AgentPluginMcp.adapt(
      {
        good: { command: "node" },
        ambiguous: { command: "node", url: "https://x.invalid" },
        unknown: { type: "carrier-pigeon", url: "https://x.invalid" },
        empty: {},
        notObject: "nope",
      },
      ctx,
    )
    expect(Object.keys(servers)).toEqual(["good"])
    expect(warnings).toHaveLength(4)
  })
})
