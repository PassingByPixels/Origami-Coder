// t-w2r1kf (t-vuw54p): Worker entry that runs the snapshot's git commands.
//
// Starting a child process holds the calling thread: 5 ms median, and up to
// 150-176 ms on Windows (scope B section 4). The snapshot starts 3-6 git
// processes per model step, so on the engine's main thread those starts froze
// every chat in the engine. Here they hold only this Worker's thread.
//
// This file must not import engine modules: it is its own entry point in the
// compiled binary (script/build.ts) and runs in its own JS heap. It spawns the
// same way as `@origami/core/cross-spawn-spawner` (cross-spawn, same options), so
// git gets the same arguments, environment and working directory as inline.
import { SpawnLock } from "@origami/core/spawn-lock"
import launch from "cross-spawn"
import type { ChildProcess } from "node:child_process"
import path from "node:path"
import type { GitWorkerReply, GitWorkerRequest } from "./git-runner"

declare const self: Worker

const running = new Map<number, ChildProcess>()

const reply = (message: GitWorkerReply, transfer: Transferable[] = []) => self.postMessage(message, transfer)

const failed = (id: number, error: unknown) =>
  reply({ type: "done", id, code: 1, stdout: new Uint8Array(0), stderr: new Uint8Array(0), error: String(error) })

const at = () => performance.timeOrigin + performance.now()

/**
 * origami_change (t-w1r73y): how long git's output may stay open after git has
 * exited with nothing new on it. Git's output normally closes a few ms after it
 * exits. On Windows a process the main thread starts while this thread starts
 * git (an MCP server at a chat's first prompt) inherits git's end of the output
 * pipes (every inheritable handle of the process goes to every child), and
 * keeps it for its whole life: the output then never closes and a reply sent
 * on "close" never comes (the R4 hang, debug_r4_hang.md). Git has exited, so
 * all it wrote is already in the pipe; the reply waits until nothing new has
 * come for this long.
 * origami_change (t-x0lim2): the spawn lock (core spawn-lock.ts) now stops the
 * two threads from starting processes at the same moment. The wait stays for
 * what the lock does not cover: a background child of git itself, and `Bun.$`.
 */
const DRAIN_MS = 250

const run = (request: Extract<GitWorkerRequest, { type: "run" }>) => {
  const recv = at()
  let proc: ChildProcess
  try {
    proc = launch("git", request.args, {
      cwd: request.cwd === undefined ? undefined : path.resolve(request.cwd),
      env: request.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
    })
  } catch (error) {
    failed(request.id, error)
    return
  }
  const spawned = at()
  // origami_change (t-w1r73y): the run has its git; the caller stops its answer clock.
  reply({ type: "started", id: request.id })
  let exited: number | undefined
  running.set(request.id, proc)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let settled = false
  let lastOutput = spawned
  const settle = (message: GitWorkerReply) => {
    if (settled) return
    settled = true
    running.delete(request.id)
    if (message.type !== "done") return reply(message)
    reply(message, [message.stdout.buffer, message.stderr.buffer])
  }
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdout.push(chunk)
    lastOutput = at()
  })
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk)
    lastOutput = at()
  })
  const done = (code: number | null, held: boolean) =>
    settle({
      type: "done",
      id: request.id,
      // A git killed by a signal has no exit code; inline reports that as a
      // failed run too.
      code: code ?? 1,
      stdout: new Uint8Array(Buffer.concat(stdout)),
      stderr: new Uint8Array(Buffer.concat(stderr)),
      at: { recv, spawned, exit: exited ?? at(), close: at() },
      ...(held ? { held } : {}),
    })
  // After exit: reply once the output has been quiet for DRAIN_MS, if it has
  // not closed by then. A timer runs before the loop reads ready output, so the
  // check itself runs after one more read pass (setImmediate), and output read
  // in that pass starts the wait again.
  const drain = (code: number | null) => {
    if (settled) return
    const wait = DRAIN_MS - (at() - Math.max(lastOutput, exited ?? 0))
    if (wait > 0) return void setTimeout(() => drain(code), wait)
    const seen = lastOutput
    setImmediate(() => {
      if (settled) return
      if (lastOutput !== seen) return drain(code)
      done(code, true)
      // Stop reading: the other holder may keep the pipe open for hours.
      proc.stdout?.destroy()
      proc.stderr?.destroy()
    })
  }
  proc.on("error", (error) =>
    settle({
      type: "done",
      id: request.id,
      code: 1,
      stdout: new Uint8Array(0),
      stderr: new Uint8Array(0),
      error: error.message,
    }),
  )
  proc.on("exit", (code) => {
    exited = at()
    drain(code)
  })
  proc.on("close", (code) => done(code, false))
  proc.stdin?.on("error", () => {})
  proc.stdin?.end(request.stdin ?? "")
}

self.onmessage = (event: MessageEvent<GitWorkerRequest>) => {
  const message = event.data
  if (message.type === "run") return run(message)
  // origami_change (t-x0lim2): git starts (through Bun.spawn) take the main
  // thread's spawn lock, so no process the main thread starts at the same
  // moment takes git's pipe ends, and git takes none of theirs.
  if (message.type === "lock") return SpawnLock.adopt(message.buffer)
  if (message.type === "kill") running.get(message.id)?.kill("SIGTERM")
}

reply({ type: "ready" })
