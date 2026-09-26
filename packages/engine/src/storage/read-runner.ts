// t-w2r1kf: whole-store read-only statements on a Bun Worker.
//
// `storage_stats` summed `length(data)` over the journal, the messages and the
// parts, and counted every table, on the engine's own bun:sqlite connection.
// bun:sqlite is synchronous, so the engine's event loop stood still for the
// whole scan (seconds on the owner's 16 GB store): every chat in that engine
// froze. `read` runs the same statements on a Worker with its own read-only
// connection to the same file; the engine's thread only waits for the reply.
//
// `read` returns undefined when the Worker cannot do it: no Worker in this
// runtime (the Node build), `ORIGAMI_STORAGE_WORKER=0`, an in-memory store, a
// Worker that fails to start, or a statement that fails there. The caller then
// runs the statements inline, as before.
import { Effect } from "effect"

declare global {
  const ORIGAMI_STORAGE_WORKER_PATH: string
}

export type ReadWorkerRequest = { readonly file: string; readonly statements: ReadonlyArray<string> }

export type ReadWorkerReply =
  | { readonly type: "done"; readonly rows: ReadonlyArray<unknown> }
  | { readonly type: "failed"; readonly error: string }

let workerUrl: string | URL | undefined
const counts = { worker: 0, inline: 0 }

const defaultUrl = (): string | URL =>
  typeof ORIGAMI_STORAGE_WORKER_PATH !== "undefined"
    ? ORIGAMI_STORAGE_WORKER_PATH
    : new URL("./read-worker.ts", import.meta.url)

/** One Worker per call: stats are asked for by hand, not per step, so an idle
 *  engine keeps no Worker heap. */
const onWorker = (request: ReadWorkerRequest) =>
  Effect.callback<ReadonlyArray<unknown> | undefined>((resume) => {
    let worker: Worker
    try {
      worker = new Worker(workerUrl ?? defaultUrl())
    } catch {
      resume(Effect.succeed(undefined))
      return
    }
    let settled = false
    const settle = (rows: ReadonlyArray<unknown> | undefined) => {
      if (settled) return
      settled = true
      worker.terminate()
      resume(Effect.succeed(rows))
    }
    worker.addEventListener("message", (event: MessageEvent<ReadWorkerReply>) =>
      settle(event.data.type === "done" ? event.data.rows : undefined),
    )
    worker.addEventListener("error", () => settle(undefined))
    worker.addEventListener("close", () => settle(undefined))
    // Bun's Worker has unref(); the DOM type the engine compiles against does not.
    ;(worker as unknown as { unref?: () => void }).unref?.()
    worker.postMessage(request)
    return Effect.sync(() => {
      settled = true
      worker.terminate()
    })
  })

/**
 * Run `statements` (read-only, one row each) against the store file `file` on
 * a Worker. Undefined when the caller must run them inline.
 */
export const read = (file: string | undefined, statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (!file || typeof Worker !== "function" || process.env.ORIGAMI_STORAGE_WORKER === "0") return undefined
    const rows = yield* onWorker({ file, statements })
    if (rows !== undefined) counts.worker += 1
    return rows
  })

export const noteInline = () => {
  counts.inline += 1
}

/** Test hooks. */
export const testing = {
  counts: () => ({ ...counts }),
  setWorkerUrl: (url: string | URL | undefined) => {
    workerUrl = url
  },
  reset: () => {
    counts.worker = 0
    counts.inline = 0
    workerUrl = undefined
  },
}

export * as StorageRead from "./read-runner"
