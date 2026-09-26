// R4 (t-w2txb2, scope C section 4): the request bytes across a REAL process boundary.
//
// The in-process restart harness (test/lib/restart-harness.ts, R1-R3) resets a list of
// module stores by name; this test does not trust that list. It runs real engine
// processes from this checkout's source (`bun run src/index.ts acp`), each on an
// isolated home and XDG store in a temp folder, against a fake OpenAI-compatible model
// served here and a real stdio MCP server that is slow to answer `initialize`.
//
//   X          one engine runs turns 1-3.
//   Y-resume   turns 1-2, the engine is stopped the way a park stops it (stdin EOF), a
//              NEW engine opens the session with `session/resume` (the silent restore the
//              extension uses), turn 3.
//   Y-load     the same, but the first engine is KILLED (no finalizer runs) and the new
//              one uses `session/load`.
//
// Every request body of every turn must be byte-identical to X (SHA-256; the one mask is
// the wall-clock `[took N s]` marker of a live tool run, see `fakeModel`). Turn 1 loads an
// MCP tool through `tool_search`, and turns 1-2 make enough reads for a tool-aging commit,
// so a restore that lost either (or sent before MCP connected) changes turn 3.
//
// R4_ENGINE_SRC points the test at another checkout's `packages/engine` (the red run
// against the base commit).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const ENGINE = process.env["R4_ENGINE_SRC"] ?? path.resolve(import.meta.dir, "../..")
const ENTRY = path.join(ENGINE, "src", "index.ts")
const ROOT = mkdtempSync(path.join(os.tmpdir(), "origami-r4-"))
const WORK = path.join(ROOT, "work")
const MCP_SCRIPT = path.join(ROOT, "mcp-server.mjs")
const FILES = 40
const SHIM = process.platform === "win32" ? ["cmd", "/c"] : []
const TOOK = /\[took \d+(?:\.\d)? s\]/g

// ------------------------------------------------------------- fake model ---

type Logged = { turn: number; step: number; tools: number; sha: string; bytes: number; body: string }

/** What the model does in each step of each turn. `reads` = files read in parallel. */
const PLAN: Record<number, Array<{ search?: string; reads?: number[]; text?: string }>> = {
  1: [{ search: "current weather" }, { reads: Array.from({ length: FILES }, (_, i) => i) }, { text: "done one" }],
  2: [{ reads: Array.from({ length: 15 }, (_, i) => i) }, { text: "done two" }],
  3: [{ reads: [FILES - 1] }, { text: "done three" }],
}

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((p: { text?: unknown }) => (typeof p?.text === "string" ? p.text : "")).join(" ")
  return ""
}

function chunk(delta: object, finish: string | null = null, usage?: object): string {
  return `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
}

function fakeModel(log: Logged[]) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "m", object: "model" }] })
      const raw = await req.text()
      const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }>; tools?: unknown[] }
      const messages = body.messages ?? []
      const tools = body.tools?.length ?? 0
      // The turn is the newest user message that carries a marker; the step is how many
      // assistant messages follow it.
      let turn = 0
      let at = -1
      messages.forEach((m, i) => {
        const hit = m.role === "user" ? /R4-TURN-(\d)/.exec(text(m.content)) : null
        if (hit) { turn = Number(hit[1]); at = i }
      })
      const step = at < 0 ? 0 : messages.slice(at + 1).filter((m) => m.role === "assistant").length
      // The one run-to-run difference of the same code: the wall-clock marker a live tool
      // run stamps on its result ("[took 0.4 s]"). It is stored with the part, so a restore
      // replays it unchanged; only two separate executions disagree on it.
      const sha = createHash("sha256").update(raw.replace(TOOK, "[took <T> s]")).digest("hex")
      if (tools > 0) log.push({ turn, step, tools, sha, bytes: raw.length, body: raw })
      const usage = { prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005 }
      const plan = tools > 0 ? PLAN[turn]?.[step] : undefined
      let out = chunk({ role: "assistant", content: "" })
      if (plan?.search) {
        const args = JSON.stringify({ query: plan.search, limit: 1 })
        out += chunk({ tool_calls: [{ index: 0, id: `call_${turn}_${step}_s`, type: "function", function: { name: "tool_search", arguments: args } }] })
        out += chunk({}, "tool_calls", usage)
      } else if (plan?.reads) {
        plan.reads.forEach((file, index) => {
          const args = JSON.stringify({ filePath: path.join(WORK, "src", `file${file}.ts`) })
          out += chunk({ tool_calls: [{ index, id: `call_${turn}_${step}_${index}`, type: "function", function: { name: "read", arguments: args } }] })
        })
        out += chunk({}, "tool_calls", usage)
      } else {
        out += chunk({ content: plan?.text ?? "A title" })
        out += chunk({}, "stop", usage)
      }
      out += "data: [DONE]\n\n"
      return new Response(out, { headers: { "Content-Type": "text/event-stream" } })
    },
  })
}

// ------------------------------------------------------------- stdio MCP ---

/** A real stdio MCP server, slow on purpose: `initialize` answers after 1.5 s, so a
 *  request built before MCP connected would lack its tools. Writes its pid to a file. */
const MCP_SOURCE = `import { createInterface } from "node:readline"
import { appendFileSync } from "node:fs"
appendFileSync(process.argv[2], process.pid + "\\n")
const tools = [
  { name: "weather_current", description: "Current weather for a city", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { name: "weather_forecast", description: "Five day forecast for a city", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
]
const rl = createInterface({ input: process.stdin })
rl.on("line", async (line) => {
  let row
  try { row = JSON.parse(line) } catch { return }
  let result = {}
  if (row.method === "initialize") {
    await new Promise((r) => setTimeout(r, 1500))
    result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "r4-weather", version: "1" }, instructions: "Weather tools for the R4 test." }
  } else if (row.method === "tools/list") result = { tools }
  else if (row.method === "tools/call") result = { content: [{ type: "text", text: "sunny" }] }
  if (row.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: row.id, result }) + "\\n")
})
rl.on("close", () => process.exit(0))
`

// ----------------------------------------------------------------- engine ---

const SECRET = /KEY|TOKEN|SECRET|PASSWORD|ANTHROPIC|OPENAI|CLAUDE|GEMINI|OPENROUTER|AZURE|AWS_|GOOGLE|HF_|GITHUB|GITEA/i
const HOMEISH = /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|TEMP|TMP)$/i
const LIVE = /\.local[\\/]+share[\\/]+origami|\.config[\\/]+origami|[\\/]\.origami(?:[\\/;]|$)/i

/** An environment whose every home and store path is inside `dir` (temp: inside ROOT). Throws when one is not. */
function isolatedEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || SECRET.test(k) || HOMEISH.test(k)) continue
    if (k.startsWith("XDG_") || k.startsWith("ORIGAMI_") || k.startsWith("BUN_") || /proxy/i.test(k)) continue
    env[k] = v
  }
  const home = path.join(dir, "home")
  Object.assign(env, {
    XDG_DATA_HOME: path.join(dir, "xdg", "data"),
    XDG_CONFIG_HOME: path.join(dir, "xdg", "config"),
    XDG_CACHE_HOME: path.join(dir, "xdg", "cache"),
    XDG_STATE_HOME: path.join(dir, "xdg", "state"),
    ORIGAMI_TEST_HOME: home,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    // One temp folder for every run: its path is in the shell tool's description, and
    // two runs of one chat on one machine share it.
    TEMP: path.join(ROOT, "tmp"),
    TMP: path.join(ROOT, "tmp"),
    ORIGAMI_DISABLE_FLOCK: "1",
    ORIGAMI_DISABLE_AUTOUPDATE: "1",
    ORIGAMI_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    TZ: "UTC",
    LANG: "en_US.UTF-8",
  })
  const inside = (p: string) => path.resolve(p).toLowerCase().startsWith(path.resolve(ROOT).toLowerCase() + path.sep)
  for (const k of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "ORIGAMI_TEST_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"])
    if (!inside(env[k]!)) throw new Error(`isolation: ${k} is outside ${dir}`)
  for (const [k, v] of Object.entries(env)) if (LIVE.test(v)) throw new Error(`isolation: ${k} names a live path`)
  return env
}

function prepareStore(dir: string, port: number) {
  for (const d of ["xdg/data", "xdg/config/origami", "xdg/cache", "xdg/state", "home/AppData/Roaming", "home/AppData/Local"])
    mkdirSync(path.join(dir, d), { recursive: true })
  mkdirSync(path.join(ROOT, "tmp"), { recursive: true })
  writeFileSync(
    path.join(dir, "xdg", "config", "origami", "origami.json"),
    JSON.stringify({
      model: "fake/m",
      small_model: "fake/m",
      enabled_providers: ["fake"],
      provider: {
        fake: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fake",
          options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "x" },
          models: { m: { name: "m", tool_call: true, attachment: false, limit: { context: 1_000_000, output: 8192 } } },
        },
      },
      permission: { bash: "allow", edit: "allow", external_directory: "allow", read: "allow" },
      // On Windows through `cmd /c`, the shape of an npx `.cmd` shim: the server is then the
      // engine's GRANDCHILD, which is the case a stop can leave behind (scope B D-12).
      mcp: { r4: { type: "local", command: [...SHIM, process.execPath, MCP_SCRIPT, path.join(dir, "mcp-pids.txt")], timeout: 20_000 } },
    }),
  )
}

/** One ACP call (a whole turn included) answers in a few seconds. A call with no
 *  answer by then fails the run with the engine's log tail; the run never waits
 *  out the 600 s hook limit in silence (t-w1r73y, debug_r4_hang.md). */
const CALL_LIMIT_MS = 60_000

class Engine {
  readonly child: ChildProcess
  private id = 0
  private readonly waiters = new Map<number, (m: { result?: any; error?: any }) => void>()
  stderr = ""
  constructor(dir: string) {
    this.child = spawn(process.execPath, ["run", "--conditions=browser", ENTRY, "acp", "--cwd", WORK], {
      cwd: WORK,
      env: isolatedEnv(dir),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    // An engine that exits answers no call it still owes: fail those now.
    this.child.once("exit", (code, signal) => {
      for (const resolve of this.waiters.values()) resolve({ error: { message: `the engine exited (code ${code}, signal ${signal})` } })
      this.waiters.clear()
    })
    let buf = ""
    this.child.stdout!.setEncoding("utf8")
    this.child.stdout!.on("data", (d: string) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let m: any
        try { m = JSON.parse(line) } catch { continue }
        if (m.id !== undefined && !m.method && this.waiters.has(m.id)) {
          this.waiters.get(m.id)!(m)
          this.waiters.delete(m.id)
        } else if (m.method && m.id !== undefined) {
          let result: unknown = null
          if (m.method === "session/request_permission") {
            const opt = (m.params.options ?? []).find((o: { kind: string }) => String(o.kind).startsWith("allow"))
            result = { outcome: { outcome: "selected", optionId: opt?.optionId } }
          }
          this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n")
        }
      }
    })
    this.child.stderr!.setEncoding("utf8")
    this.child.stderr!.on("data", (d: string) => { if (this.stderr.length < 100_000) this.stderr += d })
  }
  async call(method: string, params: unknown): Promise<any> {
    const n = ++this.id
    let timer: ReturnType<typeof setTimeout> | undefined
    const r = await new Promise<{ result?: any; error?: any }>((resolve) => {
      this.waiters.set(n, resolve)
      timer = setTimeout(() => {
        this.waiters.delete(n)
        resolve({ error: { message: `no answer in ${CALL_LIMIT_MS / 1000} s (engine pid ${this.child.pid})` } })
      }, CALL_LIMIT_MS)
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n")
    }).finally(() => clearTimeout(timer))
    if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}\n${this.stderr.slice(-4000)}`)
    return r.result
  }
  init() {
    return this.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } })
  }
  async prompt(sessionId: string, turn: number) {
    return this.call("session/prompt", { sessionId, prompt: [{ type: "text", text: `R4-TURN-${turn}: continue the task.` }] })
  }
  /** The park path: stdin EOF, the engine's finalizers run. */
  async stop() {
    const exited = new Promise((r) => this.child.once("exit", r))
    this.child.stdin!.end()
    await Promise.race([exited, Bun.sleep(15_000)])
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
  }
  /** A crash: no finalizer runs. */
  async kill() {
    const exited = new Promise((r) => this.child.once("exit", r))
    this.child.kill("SIGKILL")
    await Promise.race([exited, Bun.sleep(15_000)])
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function mcpPids(dir: string): number[] {
  try {
    return readFileSync(path.join(dir, "mcp-pids.txt"), "utf8").split("\n").filter(Boolean).map(Number)
  } catch {
    return []
  }
}

type Run = { log: Logged[]; orphans: number[]; servers: number }

async function scenario(name: string, restart: "none" | "resume" | "load"): Promise<Run> {
  const dir = path.join(ROOT, name)
  const log: Logged[] = []
  const server = fakeModel(log)
  prepareStore(dir, server.port!)
  const engines: Engine[] = []
  try {
    const first = new Engine(dir)
    engines.push(first)
    await first.init()
    const created = await first.call("session/new", { cwd: WORK, mcpServers: [] })
    const sessionId = created.sessionId as string
    await first.call("session/set_config_option", { sessionId, configId: "model", value: "fake/m" })
    await first.prompt(sessionId, 1)
    await first.prompt(sessionId, 2)
    let third = first
    const orphans: number[] = []
    let servers = 0
    if (restart !== "none") {
      const before = mcpPids(dir)
      servers = before.length
      if (restart === "resume") await first.stop()
      else await first.kill()
      // The engine's MCP children must go with it (scope B D-12: Windows grandchildren).
      await Bun.sleep(1_000)
      orphans.push(...before.filter(alive))
      third = new Engine(dir)
      engines.push(third)
      await third.init()
      await third.call(restart === "resume" ? "session/resume" : "session/load", { sessionId, cwd: WORK, mcpServers: [] })
    }
    await third.prompt(sessionId, 3)
    return { log, orphans, servers }
  } finally {
    for (const e of engines) if (e.child.exitCode === null && e.child.signalCode === null) await e.stop()
    for (const pid of mcpPids(dir)) if (alive(pid)) try { process.kill(pid) } catch {}
    server.stop(true)
  }
}

const turn = (run: Run, n: number) => run.log.filter((r) => r.turn === n)

let X: Run
let resume: Run
let load: Run

beforeAll(async () => {
  mkdirSync(path.join(WORK, "src"), { recursive: true })
  for (let i = 0; i < FILES; i++)
    writeFileSync(
      path.join(WORK, "src", `file${i}.ts`),
      Array.from({ length: 40 }, (_, line) => `export const value${i}_${line} = ${i * 100 + line} // padding padding`).join("\n") + "\n",
    )
  writeFileSync(MCP_SCRIPT, MCP_SOURCE)
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: WORK, stdio: "ignore" })
  git("init", "-q")
  git("add", ".")
  git("-c", "user.email=r4@test", "-c", "user.name=r4", "commit", "-qm", "init")
  // One after the other: each run is its own set of processes and its own store.
  X = await scenario("x", "none")
  resume = await scenario("y-resume", "resume")
  load = await scenario("y-load", "load")
}, 600_000)

afterAll(() => {
  if (!process.env["R4_KEEP"]) rmSync(ROOT, { recursive: true, force: true })
})

describe("R4: request bytes across a real engine process boundary", () => {
  test("the no-restart run makes the requests the script expects", () => {
    expect(turn(X, 1).length).toBe(3)
    expect(turn(X, 2).length).toBe(2)
    expect(turn(X, 3).length).toBe(2)
    // turn 1 loaded the MCP tool through tool_search, and turn 3 still declares it
    expect(turn(X, 1)[0]!.body).not.toContain('"name":"r4_weather_current"')
    expect(turn(X, 3)[0]!.body).toContain('"name":"r4_weather_current"')
    // the MCP server's instructions reached the system prompt
    expect(turn(X, 3)[0]!.body).toContain("Weather tools for the R4 test.")
  })

  for (const [name, get] of [["resume (park: stdin EOF)", () => resume], ["load (crash: kill)", () => load]] as const) {
    test(`${name}: turns 1-2 match the no-restart run (the harness is deterministic)`, () => {
      const run = get()
      expect(turn(run, 1).map((r) => r.sha)).toEqual(turn(X, 1).map((r) => r.sha))
      expect(turn(run, 2).map((r) => r.sha)).toEqual(turn(X, 2).map((r) => r.sha))
    })

    test(`${name}: every turn-3 body SHA equals the no-restart run`, () => {
      const run = get()
      const got = turn(run, 3)
      const want = turn(X, 3)
      expect(got.length).toBe(want.length)
      for (let i = 0; i < want.length; i++) {
        if (got[i]!.sha !== want[i]!.sha) {
          const a = want[i]!.body.replace(TOOK, "[took <T> s]")
          const b = got[i]!.body.replace(TOOK, "[took <T> s]")
          let at = 0
          while (at < a.length && a[at] === b[at]) at++
          throw new Error(
            `turn 3 request ${i + 1} differs at byte ${at} (${want[i]!.bytes} vs ${got[i]!.bytes} bytes)\n` +
              `no restart: …${a.slice(Math.max(0, at - 120), at + 200)}\n` +
              `restart:    …${b.slice(Math.max(0, at - 120), at + 200)}`,
          )
        }
      }
    })

    test(`${name}: the stopped engine left no MCP server running`, () => {
      expect(get().servers).toBeGreaterThan(0) // the check saw a real server to outlive the engine
      expect(get().orphans).toEqual([])
    })
  }
})
