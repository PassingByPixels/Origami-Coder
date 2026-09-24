// A stand-in for the `claude` CLI. It speaks the stream-json protocol the
// claude-cli transport drives, and it never contacts anything: every
// "upstream request" is a line appended to requests.log in FAKE_LOG.
//
// Shapes it prints come from the recorded Messages API SSE in
// ./anthropic-sse.json (wrapped as `stream_event.event`, as the CLI does under
// --include-partial-messages) and from the CLI 2.1.198 shapes the passthrough
// reads (packages/vscode/src/claudeCode/childFailure.ts).
//
// FAKE_SCENARIO points at a JSON file:
//   { lines: [...], second?: { afterMs, lines }, replayBad?, keepMcp?, models?, version?, auth? }
// A line `{ "__sleep": ms }` pauses.
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"
import { createInterface } from "node:readline"

const now = () => performance.timeOrigin + performance.now()
const scenario = process.env.FAKE_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_SCENARIO, "utf8")) : {}
const log = process.env.FAKE_LOG ?? ""
const out = (value: unknown) => writeSync(1, JSON.stringify(value) + "\n")
const record = (name: string, value: unknown) =>
  log && writeFileSync(path.join(log, name), JSON.stringify(value, null, 1))
const sleep = (ms: number) => Bun.sleepSync(ms)
const argv = process.argv.slice(2)
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)

if (argv.includes("--version")) {
  console.log(scenario.version ?? "2.1.263 (Claude Code)")
  process.exit(0)
}
if (argv[0] === "auth" && argv[1] === "status") {
  console.log(JSON.stringify(scenario.auth ?? { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }))
  process.exit(0)
}

if (log) {
  appendFileSync(path.join(log, "pids.log"), `${process.pid}\n`)
  record("argv.json", argv)
  record("env.json", Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FAKE_"))))
  record("spawned.json", now())
  for (const [name, option] of [
    ["settings.json", "--settings"],
    ["system.md", "--system-prompt-file"],
    ["mcp-config.json", "--mcp-config"],
  ] as const) {
    const file = flag(option)
    if (file) writeFileSync(path.join(log, name), readFileSync(file, "utf8"))
  }
}

/** Start the inert MCP server the transport configured, ask it what a real CLI asks, record the answers. */
async function probeMcp() {
  const file = flag("--mcp-config")
  if (!file) return
  const config = JSON.parse(readFileSync(file, "utf8")).mcpServers.origami
  // The picker handshake passes an empty server list.
  if (!config) return
  const server = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env },
    stdio: ["pipe", "pipe", "ignore"],
  })
  if (log) appendFileSync(path.join(log, "mcp-pid.log"), `${server.pid}\n`)
  const answers: unknown[] = []
  const reader = createInterface({ input: server.stdout! })
  const done = new Promise<void>((resolve) =>
    reader.on("line", (line) => {
      answers.push(JSON.parse(line))
      if (answers.length === 3) resolve()
    }),
  )
  for (const [id, method, params] of [
    [1, "initialize", { protocolVersion: "2024-11-05" }],
    [2, "tools/list", {}],
    [3, "tools/call", { name: "anything", arguments: {} }],
  ] as const)
    server.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  await done
  record("mcp-answers.json", answers)
  if (!scenario.keepMcp) server.stdin!.end()
}

function emit(lines: unknown[]) {
  for (const line of lines) {
    if (line && typeof line === "object" && "__sleep" in line) {
      sleep(Number((line as { __sleep: number }).__sleep))
      continue
    }
    // Timestamp BEFORE the write: the transport may kill this process the
    // instant the line lands, so nothing after the write is guaranteed to run.
    if (
      line &&
      typeof line === "object" &&
      (line as any).type === "stream_event" &&
      (line as any).event?.type === "message_stop"
    )
      if (log && !existsSync(path.join(log, "stopped.json"))) record("stopped.json", now())
    out(line)
  }
}

function upstream(label: string) {
  if (log) appendFileSync(path.join(log, "requests.log"), `${label} ${now()}\n`)
}

async function main() {
  await probeMcp()
  const rows: unknown[] = []
  const input = createInterface({ input: process.stdin })
  for await (const line of input) {
    const row = JSON.parse(line)
    rows.push(row)
    record("frames.json", rows)
    if (row.type === "control_request" && row.request?.subtype === "initialize") {
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: row.request_id,
          response: { models: scenario.models ?? [], account: scenario.account ?? {} },
        },
      })
      continue
    }
    if (row.shouldQuery === false)
      out({ type: "result", subtype: "success", is_error: false, num_turns: scenario.replayBad ? 1 : 0, result: "" })
  }
  if (!scenario.lines) return
  upstream("first")
  emit(scenario.lines)
  if (scenario.second) {
    // The CLI attempting another generation after the first complete answer.
    const until = now() + scenario.second.afterMs
    while (now() < until) {
      if (log) appendFileSync(path.join(log, "alive.log"), `${now()}\n`)
      sleep(1)
    }
    upstream("second")
    emit(scenario.second.lines)
  }
  if (scenario.hang) sleep(60_000)
  process.exit(scenario.exitCode ?? 0)
}

void main()
