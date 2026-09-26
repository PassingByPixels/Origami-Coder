// t-w2r1kf (t-vuw54p): runs the snapshot's git commands on a Bun Worker.
//
// Starting a git process holds the calling thread (up to 108-165 ms per model
// step in a big chat, window_rebuild_design section 2). One lazy Worker per
// engine takes those starts off the main thread; `git-worker.ts` spawns there.
//
// The caller always passes its inline run as well. It is used when the Worker
// is off (`ORIGAMI_SNAPSHOT_WORKER=0`), when there is no Worker (the Node build),
// when the Worker cannot start or dies, for any call the Worker did not finish,
// and when git could not be started on the Worker. The snapshot's git commands are all safe to run again (add, rm
// --cached, write-tree, read-tree, checkout, diff, show, config, gc).
//
// Nothing here reaches request bytes: tree hashes and file lists are stored on
// parts that revert and the UI read (message-v2.ts step-start has no hash).
import { SpawnLock } from "@origami/core/spawn-lock"
import { Effect } from "effect"

declare global {
  const ORIGAMI_SNAPSHOT_WORKER_PATH: string
}

export type GitWorkerRequest =
  | {
      readonly type: "run"
      readonly id: number
      readonly args: ReadonlyArray<string>
      readonly cwd?: string
      readonly env: Record<string, string | undefined>
      readonly stdin?: string
    }
  | { readonly type: "kill"; readonly id: number }
  /** origami_change (t-x0lim2): the process-wide spawn lock (spawn-lock.ts), sent first. */
  | { readonly type: "lock"; readonly buffer?: SharedArrayBuffer }

export type GitWorkerReply =
  | { readonly type: "ready" }
  /** origami_change (t-w1r73y): git was started for this run. */
  | { readonly type: "started"; readonly id: number }
  | {
      readonly type: "done"
      readonly id: number
      readonly code: number
      readonly stdout: Uint8Array
      readonly stderr: Uint8Array
      readonly error?: string
      /** Epoch ms on the Worker: request received, git started, git exited,
       *  its output closed. For the slow-run log line. */
      readonly at?: { readonly recv: number; readonly spawned: number; readonly exit: number; readonly close: number }
      /** origami_change (t-w1r73y): git exited but its output did not close
       *  (another process holds the pipe); the reply came after the drain wait. */
      readonly held?: boolean
    }

export interface GitRun {
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
  /** Extra variables on top of this process's environment, as `extendEnv`. */
  readonly env?: Record<string, string>
  readonly stdin?: string
}

export interface GitOutput {
  readonly code: number
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

/** A Worker that has not said "ready" by then is treated as broken. */
const READY_TIMEOUT_MS = 10_000
/** origami_change (t-w1r73y): a Worker that has not said "started" (or
 *  answered) for a run by then is treated as broken, as a dead one is: the
 *  call and every later one run inline. Never waits forever on the Worker. */
const ANSWER_TIMEOUT_MS = 10_000
/** An idle engine does not keep the Worker's heap. */
const IDLE_MS = 60_000
/** origami_change (t-woacbl): a run slower than this is logged with where its
 *  time went (queue on the Worker, process start, git itself, output, reply). */
const SLOW_MS = 1_000

type Mode = "auto" | "inline"
type Resolve = (output: Extract<GitWorkerReply, { type: "done" }> | undefined) => void

let mode: Mode = "auto"
let workerUrl: string | URL | undefined
let current: { worker: Worker; ready: boolean; readyTimer?: ReturnType<typeof setTimeout> } | undefined
let broken: string | undefined
let brokenLogged = false
let idleTimer: ReturnType<typeof setTimeout> | undefined
let nextId = 0
const pending = new Map<number, Resolve>()
/** origami_change (t-w1r73y): the answer clock of each run not yet started. */
const answers = new Map<number, ReturnType<typeof setTimeout>>()
let answerTimeout = ANSWER_TIMEOUT_MS
const counts = { worker: 0, inline: 0, held: 0 }

const defaultUrl = (): string | URL =>
  typeof ORIGAMI_SNAPSHOT_WORKER_PATH !== "undefined"
    ? ORIGAMI_SNAPSHOT_WORKER_PATH
    : new URL("./git-worker.ts", import.meta.url)

const epoch = () => performance.timeOrigin + performance.now()
let startedAt: number | undefined

const unref = (timer: ReturnType<typeof setTimeout>) => {
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}

const answered = (id: number) => {
  const timer = answers.get(id)
  if (timer) clearTimeout(timer)
  answers.delete(id)
}

// Every call the Worker still owes is run inline instead.
const release = () => {
  for (const id of [...answers.keys()]) answered(id)
  const waiting = [...pending.values()]
  pending.clear()
  for (const resolve of waiting) resolve(undefined)
}

const stop = (reason?: string) => {
  const entry = current
  current = undefined
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = undefined
  if (entry?.readyTimer) clearTimeout(entry.readyTimer)
  if (reason !== undefined) broken = reason
  entry?.worker.terminate()
  release()
}

const armIdle = () => {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = pending.size === 0 && current ? unref(setTimeout(() => stop(), IDLE_MS)) : undefined
}

const start = () => {
  if (typeof Worker !== "function") {
    broken = "no Worker in this runtime"
    return undefined
  }
  let worker: Worker
  try {
    worker = new Worker(workerUrl ?? defaultUrl())
  } catch (error) {
    broken = `Worker failed to start: ${error instanceof Error ? error.message : String(error)}`
    return undefined
  }
  // origami_change (t-x0lim2): this Worker starts processes; from now on every
  // process start on either thread takes the same lock.
  worker.postMessage({ type: "lock", buffer: SpawnLock.share() } satisfies GitWorkerRequest)
  const entry: NonNullable<typeof current> = { worker, ready: false }
  entry.readyTimer = unref(
    setTimeout(() => {
      if (current === entry && !entry.ready) stop("Worker did not start in time")
    }, READY_TIMEOUT_MS),
  )
  worker.addEventListener("message", (event: MessageEvent<GitWorkerReply>) => {
    const message = event.data
    if (message.type === "ready") {
      entry.ready = true
      if (entry.readyTimer) clearTimeout(entry.readyTimer)
      return
    }
    answered(message.id)
    if (message.type === "started") return
    const resolve = pending.get(message.id)
    if (!resolve) return
    pending.delete(message.id)
    resolve(message)
    if (current === entry) armIdle()
  })
  worker.addEventListener("error", (event: ErrorEvent) => {
    if (current === entry) stop(`Worker error: ${event.message}`)
  })
  worker.addEventListener("close", () => {
    if (current === entry) stop("Worker exited")
  })
  // Bun's Worker has unref(); the DOM type the engine compiles against does not.
  ;(worker as unknown as { unref?: () => void }).unref?.()
  current = entry
  startedAt = epoch()
  return entry
}

const acquire = () => {
  if (mode === "inline" || process.env.ORIGAMI_SNAPSHOT_WORKER === "0") return undefined
  if (broken !== undefined) return undefined
  return current ?? start()
}

/**
 * Run one git command on the Worker. `inline` runs it on this thread and is
 * used whenever the Worker cannot.
 */
export const run = <E, R>(input: GitRun, inline: Effect.Effect<GitOutput, E, R>): Effect.Effect<GitOutput, E, R> =>
  Effect.suspend(() => {
    const cold = current === undefined
    const entry = acquire()
    const fallback = Effect.suspend(() => {
      counts.inline += 1
      if (broken === undefined || brokenLogged) return inline
      brokenLogged = true
      return Effect.logWarning("snapshot git runs inline: the Worker is not available", { reason: broken }).pipe(
        Effect.andThen(inline),
      )
    })
    if (!entry) return fallback
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = undefined
    const id = ++nextId
    const posted = epoch()
    const env = input.env ? { ...process.env, ...input.env } : { ...process.env }
    return Effect.callback<Extract<GitWorkerReply, { type: "done" }> | undefined>((resume) => {
      pending.set(id, (output) => resume(Effect.succeed(output)))
      entry.worker.postMessage({
        type: "run",
        id,
        args: input.args,
        cwd: input.cwd,
        env,
        stdin: input.stdin,
      } satisfies GitWorkerRequest)
      answers.set(
        id,
        unref(
          setTimeout(() => {
            if (pending.has(id) && current === entry) stop(`Worker did not answer a run in ${answerTimeout} ms`)
          }, answerTimeout),
        ),
      )
      // Interrupted (the turn was aborted): stop the git process, as the
      // inline spawner's scope does.
      return Effect.sync(() => {
        answered(id)
        if (!pending.delete(id)) return
        if (current === entry) {
          entry.worker.postMessage({ type: "kill", id } satisfies GitWorkerRequest)
          armIdle()
        }
      })
    }).pipe(
      Effect.flatMap((output) => {
        // Git could not be started there (a missing cwd, say): the inline run
        // fails the same way and gives the caller the error it expects.
        if (output === undefined || output.error !== undefined) return fallback
        counts.worker += 1
        const result = { code: output.code, stdout: output.stdout, stderr: output.stderr }
        const done = epoch()
        const command = input.args.find((arg) => !arg.startsWith("-") && !arg.includes("=") && !arg.includes("/") && !arg.includes("\\"))
        // origami_change (t-w1r73y): visible in the log, as the slow run is.
        if (output.held) {
          counts.held += 1
          return Effect.logInfo("snapshot git output stayed open after git exited (another process holds the pipe)", {
            command,
            totalMs: Math.round(done - posted),
          }).pipe(Effect.as(result))
        }
        if (done - posted < SLOW_MS || !output.at) return Effect.succeed(result)
        const at = output.at
        const ms = (value: number) => Math.round(value)
        return Effect.logInfo("snapshot git slow", {
          command,
          totalMs: ms(done - posted),
          queueMs: ms(at.recv - posted),
          spawnMs: ms(at.spawned - at.recv),
          runMs: ms(at.exit - at.spawned),
          drainMs: ms(at.close - at.exit),
          replyMs: ms(done - at.close),
          workerStarted: cold,
          workerAgeMs: startedAt === undefined ? undefined : ms(posted - startedAt),
        }).pipe(Effect.as(result))
      }),
    )
  })

/** Test hooks. */
export const testing = {
  counts: () => ({ worker: counts.worker, inline: counts.inline }),
  /** origami_change (t-x0lim2): Worker runs whose output stayed open after git exited. */
  held: () => counts.held,
  /** "inline" forces the inline path; "auto" uses the Worker when it can. */
  setMode: (next: Mode) => {
    mode = next
  },
  /** Point the next Worker at another script (undefined = the real one). */
  setWorkerUrl: (url: string | URL | undefined) => {
    workerUrl = url
  },
  /** How long a run may wait for the Worker to start its git (reset restores it). */
  setAnswerTimeout: (ms: number) => {
    answerTimeout = ms
  },
  reset: () => {
    stop()
    broken = undefined
    brokenLogged = false
    answerTimeout = ANSWER_TIMEOUT_MS
    counts.worker = 0
    counts.inline = 0
    counts.held = 0
  },
  isRunning: () => current !== undefined,
}

export * as SnapshotGit from "./git-runner"
