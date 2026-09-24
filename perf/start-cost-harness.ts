/**
 * Start-cost harness for t-hca1vv (inherited from t-hb1b7e).
 *
 * Spawns the engine's `acp` command from SOURCE in an ISOLATED XDG sandbox,
 * speaks ACP over stdio (initialize + session/new) and prints the
 * `[acp-profile]` legs. The sandbox is a COPY of the real config/auth: the real
 * stores are read once and never written (see docs Part 9, "Leave real data
 * alone").
 *
 * Usage:
 *   bun run perf/start-cost-harness.ts --runs 3 [--sandbox <dir>] [--providers 1]
 *
 * `--providers 1` trims the copied config down to a single provider, which is
 * the A/B the ticket's before-table used to price one provider.
 */
import { spawn } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

const args = process.argv.slice(2)
function flag(name: string, fallback?: string) {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1]! : fallback
}

const runs = Number(flag("runs", "3"))
const onlyProviders = flag("providers")
const keepCache = args.includes("--keep-cache")
const sandbox = flag("sandbox", path.join(os.tmpdir(), "origami-start-cost"))
const repoRoot = path.resolve(import.meta.dirname, "..")

function copyReal() {
  const home = os.homedir()
  const config = path.join(sandbox, "config", "origami")
  const data = path.join(sandbox, "data", "origami")
  fs.rmSync(sandbox, { recursive: true, force: true })
  fs.mkdirSync(config, { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  fs.copyFileSync(path.join(home, ".config", "origami", "origami.json"), path.join(config, "origami.json"))
  const auth = path.join(home, ".local", "share", "origami", "auth.json")
  if (fs.existsSync(auth)) fs.copyFileSync(auth, path.join(data, "auth.json"))
  const pad = flag("pad")
  if (pad) {
    // The ticket's table is quoted at 9 providers; the live config carries 8. Clone
    // the last one under a new id so the count matches, without touching real data.
    const file = path.join(config, "origami.json")
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"))
    const ids = Object.keys(cfg.provider ?? {})
    const donor = cfg.provider[ids.at(-1)!]
    for (let n = ids.length; n < Number(pad); n++) cfg.provider[`pad-provider-${n}`] = JSON.parse(JSON.stringify(donor))
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  }
  if (onlyProviders) {
    const file = path.join(config, "origami.json")
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"))
    const keep = Object.keys(cfg.provider ?? {}).slice(0, Number(onlyProviders))
    cfg.provider = Object.fromEntries(keep.map((id) => [id, cfg.provider[id]]))
    cfg.disabled_providers = Object.keys(JSON.parse(fs.readFileSync(auth, "utf8")) ?? {}).filter(
      (id) => !keep.includes(id),
    )
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  }
  return { config, data }
}

/** Add one provider to the SANDBOX config, to prove end to end that a config change
 *  invalidates the catalog cache and is picked up by the next chat. */
function mutateConfig() {
  const file = path.join(sandbox, "config", "origami", "origami.json")
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"))
  const ids = Object.keys(cfg.provider ?? {})
  cfg.provider[`mutated-provider-${ids.length}`] = JSON.parse(JSON.stringify(cfg.provider[ids.at(-1)!]))
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
}

// `--reuse` keeps the sandbox from the previous invocation, which is what makes a
// warm-cache run and a config-change run comparable.
if (!args.includes("--reuse")) copyReal()
if (args.includes("--mutate-config")) mutateConfig()

function env() {
  return {
    ...process.env,
    ORIGAMI_ACP_PROFILE: "1",
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    XDG_DATA_HOME: path.join(sandbox, "data"),
    XDG_CACHE_HOME: path.join(sandbox, "cache"),
    XDG_STATE_HOME: path.join(sandbox, "state"),
    ORIGAMI_TEST_HOME: path.join(sandbox, "home"),
    ORIGAMI_DISABLE_FLOCK: "1",
  }
}

type Run = { boot: number; initialize: number; newSession: number; legs: Record<string, number>; providers: number }

function once(cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    // `--engine <exe>` measures the COMPILED binary, which is what a real chat
    // spawns. Without it the engine runs from source and bun's transpile cost
    // inflates every leg, so the two are never mixed in one table.
    const engine = flag("engine")
    const child = engine
      ? spawn(engine, ["acp", "--cwd", cwd], { cwd: repoRoot, env: env(), stdio: ["pipe", "pipe", "pipe"] })
      : spawn(
          process.execPath,
          ["run", "--conditions=browser", path.join(repoRoot, "packages/engine/src/index.ts"), "acp", "--cwd", cwd],
          { cwd: repoRoot, env: env(), stdio: ["pipe", "pipe", "pipe"] },
        )
    const legs: Record<string, number> = {}
    let boot = 0
    let firstOutput = 0
    child.stderr.on("data", (chunk: Buffer) => {
      if (!firstOutput) {
        firstOutput = performance.now()
        boot = firstOutput - t0
      }
      for (const line of chunk.toString().split("\n")) {
        const m = /^\[acp-profile\] (\S+) (\d+)ms/.exec(line.trim())
        if (m) legs[m[1]!] = Number(m[2])
      }
    })
    let buf = ""
    let initialize = 0
    let newSession = 0
    let sent = 0
    const send = (id: number, method: string, params: unknown) => {
      sent = performance.now()
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    }
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString()
      let at: number
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at).trim()
        buf = buf.slice(at + 1)
        if (!line) continue
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1 && "result" in msg) {
          initialize = performance.now() - sent
          send(2, "session/new", { cwd, mcpServers: [] })
        } else if (msg.id === 2) {
          newSession = performance.now() - sent
          const models: any[] = msg.result?.configOptions?.find((o: any) => o.id === "model")?.options ?? []
          if (process.env.HARNESS_DUMP) fs.writeFileSync(process.env.HARNESS_DUMP, JSON.stringify(msg.result, null, 2))
          const providers = new Set(
            models.map((o: any) => o.providerID ?? o.provider ?? String(o.value ?? o.id).split("/")[0]),
          ).size
          child.kill()
          resolve({ boot, initialize, newSession, legs, providers })
        }
      }
    })
    child.on("error", reject)
    child.on("exit", () => {
      if (!newSession) reject(new Error("engine exited before session/new"))
    })
    send(1, "initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } })
  })
}

const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!

const cwd = repoRoot
const rows: Run[] = []
for (let i = 0; i < runs; i++) {
  if (!keepCache) fs.rmSync(path.join(sandbox, "data", "origami", "cache"), { recursive: true, force: true })
  rows.push(await once(cwd))
}

const flagKeys = flag("legs")
const keys = flagKeys
  ? flagKeys.split(",")
  : [...new Set(rows.flatMap((r) => Object.keys(r.legs)))].toSorted(
      (a, b) => median(rows.map((r) => r.legs[b] ?? 0)) - median(rows.map((r) => r.legs[a] ?? 0)),
    )
console.log(`\nruns=${runs} providers=${onlyProviders ?? "all"} keepCache=${keepCache}`)
console.log(`providers in configOptions: ${rows.map((r) => r.providers).join(",")}`)
console.log("boot\tinitialize\tsession/new")
for (const row of rows) {
  console.log([Math.round(row.boot), Math.round(row.initialize), Math.round(row.newSession)].join("\t"))
}
console.log("median per profiled leg (ms):")
for (const k of keys) console.log(`  ${String(median(rows.map((r) => r.legs[k] ?? 0))).padStart(6)}  ${k}`)
console.log(
  [
    "MEDIAN",
    Math.round(median(rows.map((r) => r.boot))),
    Math.round(median(rows.map((r) => r.initialize))),
    Math.round(median(rows.map((r) => r.newSession))),
  ].join("\t"),
)
