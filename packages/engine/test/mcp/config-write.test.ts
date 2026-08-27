import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import { parse as parseJsonc } from "jsonc-parser"
import { Global } from "@origami/core/global"
import { McpConfigWrite } from "@/mcp/config-write"

/**
 * `McpConfigWrite` — the file-level `mcp` writes shared by `cli/cmd/mcp.ts`
 * and the MCP pane's ACP methods (`acp/mcp.ts`). No Effect layers: the module
 * is plain `Filesystem` + jsonc-parser, exactly like
 * `agent-plugins/config-write.ts`, and testing it against real files is what
 * proves a write LANDED rather than that a mock was called.
 *
 * Server names here are deliberately long and unique. `locate` searches the
 * GLOBAL config as well as the project one, so a plausible name ("blender",
 * "github") risks matching a real entry on the machine running the suite and
 * writing to it. Every test asserts the written path is inside the tmp root
 * as a second guard.
 */

const ROOT = path.join(Global.Path.tmp, "mcp-config-write-test")
const CONFIG = path.join(ROOT, "origami.json")
const NESTED = path.join(ROOT, ".origami", "origami.json")

// Unique enough that no real global config can hold them.
const SRV = "cfgwrite-fixture-server"
const OTHER = "cfgwrite-fixture-other"
const PLUGIN_OWNED = "cfgwrite-fixture-plugin-owned"

const readConfig = async (file = CONFIG) => parseJsonc(await readFile(file, "utf8")) as Record<string, any>

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(ROOT, { recursive: true })
})
afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

describe("McpConfigWrite.addServer — the CLI's own writer, now shared", () => {
  test("creates the file and writes the server under `mcp.<name>`", async () => {
    await McpConfigWrite.addServer(CONFIG, SRV, { type: "local", command: ["npx", "server"] })

    expect((await readConfig()).mcp[SRV]).toEqual({ type: "local", command: ["npx", "server"] })
  })

  test("PRESERVES comments and unrelated keys in an existing config", async () => {
    // The whole reason this is jsonc-parser and not JSON.stringify. A rewrite
    // that drops a user's comments is data loss they never asked for.
    await writeFile(CONFIG, '{\n  // keep me\n  "model": "anthropic/x",\n  "mcp": { "' + OTHER + '": { "type": "local", "command": ["a"] } }\n}')

    await McpConfigWrite.addServer(CONFIG, SRV, { type: "remote", url: "https://example.test/mcp" })

    const text = await readFile(CONFIG, "utf8")
    expect(text).toContain("// keep me")
    const parsed = parseJsonc(text)
    expect(parsed.model).toBe("anthropic/x")
    expect(Object.keys(parsed.mcp).toSorted()).toEqual([OTHER, SRV].toSorted())
  })
})

describe("McpConfigWrite.locate — which file a write must land on", () => {
  test("finds an entry that lives in `.origami/origami.json`, not just the top-level file", async () => {
    await mkdir(path.dirname(NESTED), { recursive: true })
    await writeFile(NESTED, JSON.stringify({ mcp: { [SRV]: { type: "local", command: ["a"] } } }))

    const located = await McpConfigWrite.locate(ROOT, SRV)

    expect(located?.path).toBe(NESTED)
  })

  test("prefers the PROJECT file when both a project and a nested file could match", async () => {
    await mkdir(path.dirname(NESTED), { recursive: true })
    await writeFile(CONFIG, JSON.stringify({ mcp: { [SRV]: { type: "local", command: ["top"] } } }))
    await writeFile(NESTED, JSON.stringify({ mcp: { [SRV]: { type: "local", command: ["nested"] } } }))

    expect((await McpConfigWrite.locate(ROOT, SRV))?.path).toBe(CONFIG)
  })

  test("answers undefined for a name no config file holds", async () => {
    expect(await McpConfigWrite.locate(ROOT, PLUGIN_OWNED)).toBeUndefined()
  })
})

describe("McpConfigWrite.setEnabled — a configured server", () => {
  test("flips `enabled` in place and keeps the rest of the definition", async () => {
    await writeFile(
      CONFIG,
      JSON.stringify({ mcp: { [SRV]: { type: "local", command: ["npx", "server"], timeout: 9000 } } }),
    )

    const written = await McpConfigWrite.setEnabled(ROOT, SRV, false)

    expect(written.path).toBe(CONFIG)
    expect((await readConfig()).mcp[SRV]).toEqual({
      type: "local",
      command: ["npx", "server"],
      timeout: 9000,
      enabled: false,
    })
  })

  test("writes to the file the entry ALREADY lives in, not to a default", async () => {
    await mkdir(path.dirname(NESTED), { recursive: true })
    await writeFile(NESTED, JSON.stringify({ mcp: { [SRV]: { type: "local", command: ["a"] } } }))

    const written = await McpConfigWrite.setEnabled(ROOT, SRV, false)

    // A write to CONFIG here would create a SECOND, shadowing entry and the
    // toggle would look like it did nothing.
    expect(written.path).toBe(NESTED)
    expect((await readConfig(NESTED)).mcp[SRV].enabled).toBe(false)
  })
})

describe("McpConfigWrite.setEnabled — a PLUGIN-provided server", () => {
  test("disabling writes the bare `{ enabled: false }` marker into the project config", async () => {
    const written = await McpConfigWrite.setEnabled(ROOT, PLUGIN_OWNED, false)

    expect(written.path).toBe(CONFIG)
    expect((await readConfig()).mcp[PLUGIN_OWNED]).toEqual({ enabled: false })
  })

  // The rule the merge in mcp/index.ts forces, and the bug it prevents:
  // `{ ...pluginServers, ...cfg.mcp }` then SKIPS any entry with no `type`.
  // Writing `{ enabled: true }` would shadow the plugin's real definition with
  // a typeless one and the server would VANISH instead of starting.
  test("re-enabling DELETES the marker instead of writing `{ enabled: true }`", async () => {
    await McpConfigWrite.setEnabled(ROOT, PLUGIN_OWNED, false)

    const written = await McpConfigWrite.setEnabled(ROOT, PLUGIN_OWNED, true)

    expect(written.path).toBe(CONFIG)
    const mcp = (await readConfig()).mcp ?? {}
    expect(Object.keys(mcp)).not.toContain(PLUGIN_OWNED)
  })

  // Reachable in the UI: a plugin may declare its own server `enabled: false`.
  // The refusal has to SAY that, or the Enable button looks broken.
  test("enabling a name that was never configured is refused, and the message says whose job it is", async () => {
    await expect(McpConfigWrite.setEnabled(ROOT, PLUGIN_OWNED, true)).rejects.toThrow(/nothing to enable/)
    await expect(McpConfigWrite.setEnabled(ROOT, PLUGIN_OWNED, true)).rejects.toThrow(/enabled in that plugin/)
  })

  test("disabling leaves other servers in the file untouched", async () => {
    await writeFile(CONFIG, JSON.stringify({ mcp: { [OTHER]: { type: "local", command: ["a"] } } }))

    await McpConfigWrite.setEnabled(ROOT, PLUGIN_OWNED, false)

    const mcp = (await readConfig()).mcp
    expect(mcp[OTHER]).toEqual({ type: "local", command: ["a"] })
    expect(mcp[PLUGIN_OWNED]).toEqual({ enabled: false })
  })
})

describe("McpConfigWrite.remove", () => {
  test("deletes ONLY the named entry", async () => {
    await writeFile(
      CONFIG,
      JSON.stringify({
        model: "anthropic/x",
        mcp: { [SRV]: { type: "local", command: ["a"] }, [OTHER]: { type: "local", command: ["b"] } },
      }),
    )

    const written = await McpConfigWrite.remove(ROOT, SRV)

    expect(written.path).toBe(CONFIG)
    const parsed = await readConfig()
    expect(Object.keys(parsed.mcp)).toEqual([OTHER])
    expect(parsed.model).toBe("anthropic/x")
  })

  test("refuses a name no config file holds — a plugin's server is not ours to delete", async () => {
    await expect(McpConfigWrite.remove(ROOT, PLUGIN_OWNED)).rejects.toThrow(/is not in mcp in any/)
  })
})

describe("McpConfigWrite.resolveConfigPath", () => {
  test("returns an EXISTING `.origami/origami.json` over the not-yet-created top-level default", async () => {
    await mkdir(path.dirname(NESTED), { recursive: true })
    await writeFile(NESTED, "{}")

    expect(await McpConfigWrite.resolveConfigPath(ROOT)).toBe(NESTED)
  })

  test("defaults to `origami.json` when nothing exists yet", async () => {
    expect(await McpConfigWrite.resolveConfigPath(ROOT)).toBe(CONFIG)
  })

  test("the GLOBAL form never offers a `.origami/` subdirectory candidate", async () => {
    // Global config has no project-style nested folder; offering one would
    // write somewhere the loader does not read.
    await mkdir(path.dirname(NESTED), { recursive: true })
    await writeFile(NESTED, "{}")

    expect(await McpConfigWrite.resolveConfigPath(ROOT, true)).toBe(CONFIG)
  })
})
