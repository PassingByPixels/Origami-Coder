import { describe, expect } from "bun:test"
import path from "path"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { FSUtil } from "@origami/core/fs-util"
import { Global } from "@origami/core/global"
import { ACPAgentPlugins } from "@/acp/agent-plugins"
import { testEffect } from "../lib/effect"

/**
 * `ACPAgentPlugins.add` — the `agent_plugin_add` ext method's engine-side
 * implementation, the "add from folder" button's target. The acceptance line
 * this covers: "add-from-folder rejects an invalid manifest with the
 * parser's error" — asserted against the SAME message
 * `AgentPluginLoader`/`AgentPluginManifest.parse` actually produce (loader.ts
 * and manifest.ts's own tests), never a paraphrase.
 */

const FIXTURES = path.resolve(import.meta.dir, "../fixture/agent-plugins")
const ROOT = path.join(Global.Path.tmp, "acp-agent-plugins-add-test")
const CONFIG = path.join(ROOT, "origami.json")

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node])))

describe("ACPAgentPlugins.add — validates BEFORE writing config", () => {
  it.live("rejects a folder with no manifest, verbatim from the loader, and writes no config", () =>
    Effect.gen(function* () {
      const dir = path.join(ROOT, "no-manifest")
      yield* Effect.promise(() => rm(ROOT, { recursive: true, force: true }))
      yield* Effect.promise(() => mkdir(dir, { recursive: true }))

      const result = yield* ACPAgentPlugins.add(ROOT, dir)

      expect(result.ok).toBe(false)
      if (result.ok) return
      // AgentPluginLoader.resolve's own wording (loader.ts), not a paraphrase.
      expect(result.message).toContain("no manifest at")
      expect(result.message).toContain(dir)

      const configExists = yield* Effect.promise(() =>
        readFile(CONFIG, "utf8")
          .then(() => true)
          .catch(() => false),
      )
      expect(configExists).toBe(false)
    }),
  )

  it.live("rejects a manifest that fails schema validation, and the message names the manifest file", () =>
    Effect.gen(function* () {
      const dir = path.join(ROOT, "bad-manifest")
      yield* Effect.promise(() => rm(ROOT, { recursive: true, force: true }))
      yield* Effect.promise(() => mkdir(dir, { recursive: true }))
      yield* Effect.promise(() =>
        writeFile(
          path.join(dir, "plugin.json"),
          // Declares 1.0.0 conformance but the name fails the published
          // pattern (uppercase + space + '!') — a STRICT-mode failure, so
          // AgentPluginManifest.parse must reject it, not silently reinterpret
          // it as a lenient Claude-format manifest.
          JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name: "Bad Name!",
          }),
        ),
      )

      const result = yield* ACPAgentPlugins.add(ROOT, dir)

      expect(result.ok).toBe(false)
      if (result.ok) return
      // load()'s own format: `${manifestPath}: ${issues.join("; ")}` — the
      // path prefix proves this is the loader's real output, not a rewrite.
      expect(result.message).toContain(path.join(dir, "plugin.json"))
    }),
  )

  it.live("accepts a valid plugin, appends the spec, and reports its parsed name", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => rm(ROOT, { recursive: true, force: true }))
      yield* Effect.promise(() => mkdir(ROOT, { recursive: true }))
      const spec = path.join(FIXTURES, "standard")

      const result = yield* ACPAgentPlugins.add(ROOT, spec)

      expect(result.ok, result.ok ? "" : result.message).toBe(true)
      if (!result.ok) return
      expect(result.name).toBe("standard.fixture")
      expect(result.path).toBe(CONFIG)

      const written = JSON.parse(yield* Effect.promise(() => readFile(CONFIG, "utf8")))
      expect(written.agentPlugins).toEqual([spec])
    }),
  )

  it.live("a second add of the same spec is refused, and the message is the config writer's own", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => rm(ROOT, { recursive: true, force: true }))
      yield* Effect.promise(() => mkdir(ROOT, { recursive: true }))
      const spec = path.join(FIXTURES, "standard")

      const first = yield* ACPAgentPlugins.add(ROOT, spec)
      expect(first.ok).toBe(true)

      const second = yield* ACPAgentPlugins.add(ROOT, spec)
      expect(second.ok).toBe(false)
      if (second.ok) return
      expect(second.message).toContain("already configured")
    }),
  )
})
