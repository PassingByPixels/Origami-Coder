import { spawn } from "node:child_process"
import { Cause, Context, Effect, Layer, Queue } from "effect"
import { LLMError, TransportReason } from "../../schema"

/**
 * A child process the `claude-cli` transport drives: one stdin it writes JSON
 * lines to, one stdout it reads JSON lines from, and a kill that takes the whole
 * process tree down.
 *
 * Injectable through `TransportRuntime.process` (or this `Service`), so a test
 * runs a fake CLI and no test ever starts the real one.
 */
export interface SpawnInput {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export interface Handle {
  readonly pid: number | undefined
  /** Complete stdout lines, in order. Ends when stdout closes. */
  readonly lines: Queue.Dequeue<string, LLMError | Cause.Done>
  readonly write: (line: string) => Effect.Effect<void, LLMError>
  readonly closeInput: Effect.Effect<void>
  /** Kill the process and every descendant. Safe to call more than once. */
  readonly kill: Effect.Effect<void>
  /** Resolves with the exit code once the process is gone (null after a signal). */
  readonly exited: Effect.Effect<number | null>
  /** The last lines the process wrote to stderr. */
  readonly stderr: () => ReadonlyArray<string>
}

export interface Interface {
  readonly spawn: (input: SpawnInput) => Effect.Effect<Handle, LLMError>
}

export class Service extends Context.Service<Service, Interface>()("@origami/LLM/ProcessExecutor") {}

const STDERR_LINES = 8

const transportError = (message: string, kind: string) =>
  new LLMError({ module: "ProcessExecutor", method: "spawn", reason: new TransportReason({ message, kind }) })

/**
 * Kill `pid` and its descendants.
 *
 * The direct process is terminated FIRST and at once: for a native binary
 * (claude.exe, or claude on POSIX) that process is the one holding the
 * upstream request, so every millisecond before it dies is a window for a
 * second request. Its descendants are then taken down as well: the POSIX
 * group kill is atomic; on Windows `taskkill /T` is best effort, because a
 * dead root has no tree left to walk. The only child the CLI starts here is
 * the inert MCP server, and it exits by itself when its stdin closes.
 */
const killTree = (child: ReturnType<typeof spawn>) => {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const pid = child.pid
  if (process.platform === "win32") {
    child.kill()
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).on("error", () => {})
    } catch {
      // The root is already gone; nothing left to walk.
    }
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

export const spawnNode = (input: SpawnInput) =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string, LLMError | Cause.Done>()
    const child = yield* Effect.try({
      try: () =>
        spawn(input.command, [...input.args], {
          cwd: input.cwd,
          env: { ...input.env },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          // A new process group on POSIX so the kill above takes the group.
          detached: process.platform !== "win32",
        }),
      catch: (error) => transportError(error instanceof Error ? error.message : String(error), "spawn"),
    })
    const tail: string[] = []
    const decoder = new TextDecoder()
    const errDecoder = new TextDecoder()
    let pending = ""
    child.stdout!.on("data", (chunk: Uint8Array) => {
      pending += decoder.decode(chunk, { stream: true })
      let index = pending.indexOf("\n")
      while (index >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, "")
        pending = pending.slice(index + 1)
        if (line.trim() !== "") Queue.offerUnsafe(lines, line)
        index = pending.indexOf("\n")
      }
    })
    child.stdout!.on("close", () => {
      if (pending.trim() !== "") Queue.offerUnsafe(lines, pending.replace(/\r$/, ""))
      pending = ""
      Queue.endUnsafe(lines)
    })
    child.stderr!.on("data", (chunk: Uint8Array) => {
      for (const line of errDecoder.decode(chunk, { stream: true }).split("\n")) {
        if (line.trim() === "") continue
        tail.push(line.trim())
        if (tail.length > STDERR_LINES) tail.shift()
      }
    })
    // EPIPE on a stdin the child already closed is reported by the write below.
    child.stdin!.on("error", () => {})
    const exit = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code))
      child.on("error", (error) => {
        Queue.failCauseUnsafe(
          lines,
          Cause.fail(transportError(`Failed to start ${input.command}: ${error.message}`, "spawn")),
        )
        resolve(null)
      })
    })
    return {
      pid: child.pid,
      lines,
      write: (line: string) =>
        Effect.callback<void, LLMError>((resume) => {
          if (!child.stdin || child.stdin.destroyed) {
            resume(Effect.fail(transportError("The process closed its input", "write")))
            return
          }
          child.stdin.write(line + "\n", (error) =>
            resume(error ? Effect.fail(transportError(error.message, "write")) : Effect.void),
          )
        }),
      closeInput: Effect.sync(() => child.stdin?.end()),
      kill: Effect.sync(() => killTree(child)),
      exited: Effect.promise(() => exit),
      stderr: () => [...tail],
    } satisfies Handle
  })

export const layer: Layer.Layer<Service> = Layer.succeed(Service, Service.of({ spawn: spawnNode }))

export const ProcessExecutor = { Service, layer, spawnNode } as const
