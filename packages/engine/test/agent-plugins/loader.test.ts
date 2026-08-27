import { describe, expect } from "bun:test"
import path from "path"
import { mkdir, rm, symlink, writeFile } from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { FSUtil } from "@origami/core/fs-util"
import { Global } from "@origami/core/global"
import { AgentPluginLoader } from "@/agent-plugins/loader"
import { AgentPluginPath } from "@/agent-plugins/containment"
import { testEffect } from "../lib/effect"

const FIXTURES = path.resolve(import.meta.dir, "../fixture/agent-plugins")
const DATA_ROOT = path.join(Global.Path.tmp, "agent-plugins-test-data")
const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node])))

/**
 * Make a directory link, by whatever mechanism this machine allows.
 *
 * `fs.symlink` is EPERM for an unprivileged Windows user, which is how the first
 * version of these tests came to "pass" without ever creating a link — they
 * caught the error and returned. A NTFS junction needs no privilege, is resolved
 * by `realpathSync.native`, and is followed by directory traversal, so it is the
 * same escape by the means an attacker on Windows would actually have.
 */
async function linkDir(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, "dir")
    return true
  } catch {
    if (process.platform !== "win32") return false
    return Bun.spawnSync(["cmd", "/c", "mklink", "/J", link, target]).exitCode === 0
  }
}

const LINKS_WORK = await (async () => {
  const probe = path.join(Global.Path.tmp, "agent-plugins-linkprobe")
  await rm(probe, { recursive: true, force: true })
  await mkdir(path.join(probe, "target"), { recursive: true })
  const ok = await linkDir(path.join(probe, "target"), path.join(probe, "link"))
  await rm(probe, { recursive: true, force: true })
  return ok
})()

/**
 * Declared as SKIPPED, never as passing, when the machine cannot make a link at
 * all. A containment test that quietly returns before it links anything is worse
 * than no test: it reports green for the exact case it exists to cover.
 */
const linkIt = LINKS_WORK ? it.live : it.live.skip

const loadFixture = Effect.fnUntraced(function* (dir: string) {
  const fsys = yield* FSUtil.Service
  const resolved = yield* AgentPluginLoader.resolve({ spec: dir }, fsys, Global.Path.home, FIXTURES)
  if (!resolved.ok) return { ok: false as const, message: resolved.value.message }
  const loaded = yield* AgentPluginLoader.load(resolved.value, fsys, DATA_ROOT)
  if (!loaded.ok) return { ok: false as const, message: loaded.value.message }
  return { ok: true as const, plugin: loaded.value }
})

describe("AgentPluginLoader", () => {
  it.live("loads the Qwen-shaped plugin: manifest under .claude-plugin, skill/ not skills/", () =>
    Effect.gen(function* () {
      const result = yield* loadFixture("qwen-shaped")
      expect(result.ok, result.ok ? "" : result.message).toBe(true)
      if (!result.ok) return
      const plugin = result.plugin

      expect(plugin.mode).toBe("lenient")
      expect(plugin.name).toBe("qwen-shaped-blender")
      expect(plugin.manifestPath.endsWith(path.join(".claude-plugin", "plugin.json"))).toBe(true)

      // The whole point of honouring the declared `skills` array: this file is at
      // skill/SKILL.md, which the 1.0.0 layout rule would never find.
      expect(plugin.skillFiles).toHaveLength(1)
      expect(plugin.skillFiles[0]!.endsWith(path.join("skill", "SKILL.md"))).toBe(true)

      const server = plugin.mcp["qwen-shaped-blender"]!
      expect(server.type).toBe("local")
      if (server.type !== "local") return
      expect(server.command[0]).toBe("uvx")
      expect(server.environment?.["QWEN_MM_AUTOLAUNCH"]).toBe("1")
      expect(server.environment?.["PLUGIN_ROOT"]).toBe(plugin.root)
      expect(server.environment?.["PLUGIN_DATA"]).toBe(plugin.dataDir)
    }),
  )

  it.live("creates the plugin data directory before anything could spawn", () =>
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const result = yield* loadFixture("qwen-shaped")
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(yield* fsys.isDir(result.plugin.dataDir)).toBe(true)
    }),
  )

  it.live("loads a conforming 1.0.0 plugin from mcp.json and the skills/ layout", () =>
    Effect.gen(function* () {
      const result = yield* loadFixture("standard")
      expect(result.ok, result.ok ? "" : result.message).toBe(true)
      if (!result.ok) return
      const plugin = result.plugin

      expect(plugin.mode).toBe("strict")
      expect(plugin.skillFiles).toHaveLength(1)
      expect(plugin.skillFiles[0]!.endsWith(path.join("skills", "mapper", "SKILL.md"))).toBe(true)
      expect(Object.keys(plugin.mcp).toSorted()).toEqual(["standard-local", "standard-remote"])

      const local = plugin.mcp["standard-local"]!
      expect(local.type === "local" && local.command).toEqual([
        "node",
        `${plugin.root}/server.js`,
        "--state",
        `${plugin.dataDir}/state.json`,
      ])
      expect(plugin.mcp["standard-remote"]).toEqual({
        type: "remote",
        url: "https://example.invalid/sse",
        headers: { "X-Fixture": "1" },
      })
    }),
  )

  it.live("reads a dot-prefixed .mcp.json for a lenient plugin", () =>
    Effect.gen(function* () {
      // The Claude-Code convention the Qwen packages use: no embedded mcpServers,
      // a hidden `.mcp.json` at the plugin root. The standard's filename is
      // `mcp.json`, so this fallback is lenient-only.
      const result = yield* loadFixture("dot-mcp")
      expect(result.ok, result.ok ? "" : result.message).toBe(true)
      if (!result.ok) return
      expect(result.plugin.mode).toBe("lenient")
      const server = result.plugin.mcp["dot-server"]!
      expect(server.type === "local" && server.command).toEqual(["uvx", "--from", "pkg", "entry"])
    }),
  )

  it.live("does NOT read .mcp.json for a plugin that claims 1.0.0 conformance", () =>
    Effect.gen(function* () {
      // Same directory, one added `$schema`. A manifest asserting the standard is
      // held to the standard's filename, so the hidden file is not honoured.
      const fsys = yield* FSUtil.Service
      const root = path.join(Global.Path.tmp, "agent-plugins-strict-dot")
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
      yield* Effect.promise(() => mkdir(root, { recursive: true }))
      yield* Effect.promise(() =>
        writeFile(path.join(root, "plugin.json"), JSON.stringify({ $schema: SCHEMA, name: "strict-dot" })),
      )
      yield* Effect.promise(() =>
        writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { s: { command: "node" } } })),
      )

      const resolved = yield* AgentPluginLoader.resolve({ spec: root }, fsys, Global.Path.home, FIXTURES)
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) return
      const loaded = yield* AgentPluginLoader.load(resolved.value, fsys, DATA_ROOT)
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) return
      expect(loaded.value.mode).toBe("strict")
      expect(loaded.value.mcp).toEqual({})

      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    }),
  )

  it.live("reports a directory with no manifest instead of loading nothing quietly", () =>
    Effect.gen(function* () {
      const result = yield* loadFixture(".")
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain("no manifest at")
    }),
  )

  linkIt("drops a skill that a link points outside the plugin root", () =>
    Effect.gen(function* () {
      // §4.1, on the real filesystem. Directory traversal follows the link, so
      // without the post-scan containment check this SKILL.md would be loaded and
      // shown to the model as the plugin's own.
      const root = path.join(Global.Path.tmp, "agent-plugins-escape", "plugin")
      const outside = path.join(Global.Path.tmp, "agent-plugins-escape", "elsewhere")
      yield* Effect.promise(() => rm(path.dirname(root), { recursive: true, force: true }))
      yield* Effect.promise(() => mkdir(path.join(root, "skills"), { recursive: true }))
      yield* Effect.promise(() => mkdir(outside, { recursive: true }))
      yield* Effect.promise(() =>
        writeFile(path.join(outside, "SKILL.md"), "---\nname: stolen\ndescription: outside\n---\n"),
      )
      yield* Effect.promise(() =>
        writeFile(path.join(root, "plugin.json"), JSON.stringify({ $schema: SCHEMA, name: "escape" })),
      )
      expect(yield* Effect.promise(() => linkDir(outside, path.join(root, "skills", "linked")))).toBe(true)

      const fsys = yield* FSUtil.Service
      const resolved = yield* AgentPluginLoader.resolve({ spec: root }, fsys, Global.Path.home, FIXTURES)
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) return
      const loaded = yield* AgentPluginLoader.load(resolved.value, fsys, DATA_ROOT)
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) return

      expect(loaded.value.skillFiles).toEqual([])
      // The warning is the half that matters. Without it an empty `skillFiles`
      // would be equally consistent with "the scan never followed the link", and
      // the test would be proving nothing about containment.
      expect(loaded.value.warnings.join(" ")).toContain("outside the plugin root")

      yield* Effect.promise(() => rm(path.dirname(root), { recursive: true, force: true }))
    }),
  )
})

describe("AgentPluginPath", () => {
  linkIt("resolves a path whose leaf does not exist without losing the linked parent", () =>
    Effect.gen(function* () {
      const base = path.join(Global.Path.tmp, "agent-plugins-real")
      const target = path.join(base, "target")
      const link = path.join(base, "link")
      yield* Effect.promise(() => rm(base, { recursive: true, force: true }))
      yield* Effect.promise(() => mkdir(target, { recursive: true }))
      expect(yield* Effect.promise(() => linkDir(target, link))).toBe(true)

      // The naive "catch ENOENT, return path.resolve" fallback returns
      // <base>/link/missing here and never resolves the link — which is how an
      // escape gets through a containment check that looks correct.
      expect(AgentPluginPath.real(path.join(link, "missing"))).toBe(
        path.join(AgentPluginPath.real(target), "missing"),
      )
      yield* Effect.promise(() => rm(base, { recursive: true, force: true }))
    }),
  )

  it.live("treats the root itself as contained and a sibling prefix as not", () =>
    Effect.sync(() => {
      const root = path.join(FIXTURES, "standard")
      expect(AgentPluginPath.within(root, root)).toBe(true)
      expect(AgentPluginPath.within(root, path.join(root, "skills"))).toBe(true)
      // "standard-x" starts with "standard" as a STRING but is a different
      // directory; a naive startsWith without the separator says otherwise.
      expect(AgentPluginPath.within(root, `${root}-x`)).toBe(false)
      expect(AgentPluginPath.within(root, path.join(FIXTURES, "qwen-shaped"))).toBe(false)
    }),
  )
})
