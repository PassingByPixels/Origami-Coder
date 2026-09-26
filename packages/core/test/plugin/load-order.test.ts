import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { describe, expect, test } from "bun:test"

// Every built-in plugin module must load when it is the FIRST module of a fresh
// process. plugin/internal.ts imports all built-in plugins and plugin/provider.ts
// builds its list at load time, so a plugin module that imports ./internal at
// runtime fails with "Cannot access '<Name>Plugin' before initialization" when it
// loads first. In one shared test process an earlier file hides this, so each
// module gets its own process here.
const src = path.join(import.meta.dir, "..", "..", "src")
const modules = [
  ...fs.readdirSync(path.join(src, "plugin", "provider")).map((file) => path.join(src, "plugin", "provider", file)),
  ...["agent.ts", "command.ts", "models-dev.ts", "variant.ts"].map((file) => path.join(src, "plugin", file)),
  ...fs.readdirSync(path.join(src, "config", "plugin")).map((file) => path.join(src, "config", "plugin", file)),
].filter((file) => file.endsWith(".ts"))

async function loadFirst(file: string) {
  const proc = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(pathToFileURL(file).href)})`], {
    cwd: path.join(src, ".."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { file: path.relative(src, file).replaceAll("\\", "/"), code, error: code === 0 ? "" : stderr.trim().split("\n").slice(-12).join("\n") }
}

describe("built-in plugin modules", () => {
  test(
    "each loads as the first module of a fresh process",
    async () => {
      expect(modules.length).toBeGreaterThan(30)
      const results: Awaited<ReturnType<typeof loadFirst>>[] = []
      // Four processes at a time: enough to keep the test short, few enough for a shared machine.
      for (let i = 0; i < modules.length; i += 4) results.push(...(await Promise.all(modules.slice(i, i + 4).map(loadFirst))))
      expect(results.filter((result) => result.code !== 0)).toEqual([])
    },
    { timeout: 120_000 },
  )
})
