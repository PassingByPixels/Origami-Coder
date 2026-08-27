import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import path from "path"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import { Global } from "@origami/core/global"
import { AgentPluginConfigWrite } from "@/agent-plugins/config-write"

/**
 * The Plugins pane's two config writes, at the file level — no Effect, no
 * engine boot, matching config-write.ts's own scope. `setEnabled`'s
 * round-trip is the acceptance line from t-kgtolm round 3: "enable/disable
 * round-trips config".
 */

const ROOT = path.join(Global.Path.tmp, "agent-plugins-config-write-test")
const CONFIG = path.join(ROOT, "origami.json")

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(ROOT, { recursive: true })
})
afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

describe("AgentPluginConfigWrite.addPlugin", () => {
  it("creates a project origami.json and appends the spec", async () => {
    const result = await AgentPluginConfigWrite.addPlugin(ROOT, "./my-plugin")
    expect(result.path).toBe(CONFIG)
    const written = JSON.parse(await readFile(CONFIG, "utf8"))
    expect(written.agentPlugins).toEqual(["./my-plugin"])
  })

  it("preserves an unrelated key and an existing entry when appending", async () => {
    await writeFile(CONFIG, JSON.stringify({ model: "anthropic/claude", agentPlugins: ["./existing"] }))

    await AgentPluginConfigWrite.addPlugin(ROOT, "./new-one")

    const written = JSON.parse(await readFile(CONFIG, "utf8"))
    expect(written.model).toBe("anthropic/claude")
    expect(written.agentPlugins).toEqual(["./existing", "./new-one"])
  })

  it("refuses a spec that is already configured, writing nothing", async () => {
    await writeFile(CONFIG, JSON.stringify({ agentPlugins: ["./my-plugin"] }))

    await expect(AgentPluginConfigWrite.addPlugin(ROOT, "./my-plugin")).rejects.toThrow(/already configured/)

    const written = JSON.parse(await readFile(CONFIG, "utf8"))
    expect(written.agentPlugins).toEqual(["./my-plugin"])
  })

  it("treats a disabled (object-form) entry as already configured too", async () => {
    await writeFile(CONFIG, JSON.stringify({ agentPlugins: [{ spec: "./my-plugin", enabled: false }] }))

    await expect(AgentPluginConfigWrite.addPlugin(ROOT, "./my-plugin")).rejects.toThrow(/already configured/)
  })
})

describe("AgentPluginConfigWrite.setEnabled — round-trips config", () => {
  it("disables a plain-string entry by rewriting it to the object form", async () => {
    await writeFile(CONFIG, JSON.stringify({ agentPlugins: ["./my-plugin"] }))

    const result = await AgentPluginConfigWrite.setEnabled(ROOT, "./my-plugin", false)

    expect(result.path).toBe(CONFIG)
    const written = JSON.parse(await readFile(CONFIG, "utf8"))
    expect(written.agentPlugins).toEqual([{ spec: "./my-plugin", enabled: false }])
  })

  it("re-enabling collapses the entry back to a plain string, not {enabled: true}", async () => {
    await writeFile(CONFIG, JSON.stringify({ agentPlugins: [{ spec: "./my-plugin", enabled: false }] }))

    await AgentPluginConfigWrite.setEnabled(ROOT, "./my-plugin", true)

    const written = JSON.parse(await readFile(CONFIG, "utf8"))
    expect(written.agentPlugins).toEqual(["./my-plugin"])
  })

  it("round-trips enable -> disable -> enable, ending exactly where it started", async () => {
    await writeFile(CONFIG, JSON.stringify({ agentPlugins: ["./my-plugin", "./other"] }))

    await AgentPluginConfigWrite.setEnabled(ROOT, "./my-plugin", false)
    let written = JSON.parse(await readFile(CONFIG, "utf8"))
    expect(written.agentPlugins).toEqual([{ spec: "./my-plugin", enabled: false }, "./other"])

    await AgentPluginConfigWrite.setEnabled(ROOT, "./my-plugin", true)
    written = JSON.parse(await readFile(CONFIG, "utf8"))
    expect(written.agentPlugins).toEqual(["./my-plugin", "./other"])
  })

  it("leaves every other entry untouched when toggling one", async () => {
    await writeFile(CONFIG, JSON.stringify({ agentPlugins: ["./a", "./b", "./c"] }))

    await AgentPluginConfigWrite.setEnabled(ROOT, "./b", false)

    const written = JSON.parse(await readFile(CONFIG, "utf8"))
    expect(written.agentPlugins).toEqual(["./a", { spec: "./b", enabled: false }, "./c"])
  })

  it("throws for a spec that is not configured anywhere, writing nothing", async () => {
    await writeFile(CONFIG, JSON.stringify({ agentPlugins: ["./my-plugin"] }))

    await expect(AgentPluginConfigWrite.setEnabled(ROOT, "./nope", false)).rejects.toThrow(/not in agentPlugins/)

    const written = JSON.parse(await readFile(CONFIG, "utf8"))
    expect(written.agentPlugins).toEqual(["./my-plugin"])
  })
})
