import { describe, expect, test } from "bun:test"
import path from "path"
import { AgentPluginManifest } from "@/agent-plugins/manifest"

/**
 * The fixture is a copy of QwenLM/Qwen-MM-Plugins
 * `src/capabilities/blender/.claude-plugin/plugin.json`, fetched 2026-08-11.
 * It is read from disk rather than inlined so the "real-world format" claim is
 * anchored to a file a reviewer can diff against upstream, not to a literal in a
 * test that could drift into agreeing with the parser.
 */
const qwen = await Bun.file(
  path.join(import.meta.dir, "../fixture/agent-plugins/qwen-shaped/.claude-plugin/plugin.json"),
).json()

const standard = await Bun.file(path.join(import.meta.dir, "../fixture/agent-plugins/standard/plugin.json")).json()

describe("AgentPluginManifest.parse", () => {
  test("accepts the real Qwen manifest shape in lenient mode", () => {
    const result = AgentPluginManifest.parse(qwen)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mode).toBe("lenient")
    expect(result.manifest.name).toBe("qwen-shaped-blender")
    // The two extension fields lenient mode exists for.
    expect(result.manifest.skillPaths).toEqual(["./skill"])
    expect(Object.keys(result.manifest.inlineMcpServers ?? {})).toEqual(["qwen-shaped-blender"])
  })

  test("the SAME manifest is rejected once it claims 1.0.0 conformance", () => {
    // One added key flips the mode. This is the conflict the ticket recorded:
    // the closed schema forbids `skills` and `mcpServers`, so a manifest cannot
    // both assert 1.0.0 and carry them.
    const result = AgentPluginManifest.parse({
      $schema: AgentPluginManifest.MANIFEST_SCHEMA,
      ...qwen,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.join(" ")).toContain("unrecognized keys")
    expect(result.issues.join(" ")).toContain("skills")
    expect(result.issues.join(" ")).toContain("mcpServers")
  })

  test("accepts a conforming 1.0.0 manifest and declares no skill paths", () => {
    const result = AgentPluginManifest.parse(standard)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mode).toBe("strict")
    expect(result.manifest.name).toBe("standard.fixture")
    // Strict manifests have no `skills` key at all; the loader must fall back to
    // the `skills/` layout rather than finding nothing.
    expect(result.manifest.skillPaths).toEqual([])
    expect(result.warnings).toEqual([])
  })

  test("rejects a $schema that names a different version", () => {
    const result = AgentPluginManifest.parse({
      $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
      name: "x",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.join(" ")).toContain("$schema")
  })

  test("rejects names that could forge a permission target", () => {
    // `name` becomes `plugin:<name>:*`. A wildcard or separator inside it would
    // let a plugin widen its own rule scope, so it is checked in BOTH modes.
    for (const name of ["evil:*", "Evil", "-lead", "a--b", "..", ""]) {
      const result = AgentPluginManifest.parse({ name })
      expect(result.ok, `name ${JSON.stringify(name)} must be rejected`).toBe(false)
    }
    expect(AgentPluginManifest.parse({ name: "a".repeat(65) }).ok).toBe(false)
    expect(AgentPluginManifest.parse({ name: "a".repeat(64) }).ok).toBe(true)
  })

  test("lenient mode reports unknown keys instead of swallowing them", () => {
    const result = AgentPluginManifest.parse({ name: "typo", skils: ["./skill"] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.join(" ")).toContain("skils")
    expect(result.manifest.skillPaths).toEqual([])
  })

  test("reads the Codex spelling of skills and mcpServers", () => {
    // Codex-format manifests write bare strings where Claude-format writes an
    // array and an object: `"skills": "./skill"`, `"mcpServers": "./.mcp.json"`.
    const result = AgentPluginManifest.parse({ name: "codex", skills: "./skill", mcpServers: "./.mcp.json" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.skillPaths).toEqual(["./skill"])
    expect(result.manifest.mcpPath).toBe("./.mcp.json")
    expect(result.manifest.inlineMcpServers).toBeUndefined()
  })

  test("rejects a manifest that is not an object", () => {
    expect(AgentPluginManifest.parse([]).ok).toBe(false)
    expect(AgentPluginManifest.parse(null).ok).toBe(false)
    expect(AgentPluginManifest.parse("{}").ok).toBe(false)
  })
})
