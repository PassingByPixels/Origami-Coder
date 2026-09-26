// t-w2r1kf: Worker entry for whole-store read-only queries (storage stats).
//
// bun:sqlite is synchronous: a full scan of a multi-gigabyte table on the
// engine's connection held the event loop for seconds. This Worker opens its
// own read-only connection to the same file and runs the statements there, so
// the engine's thread only waits for a message.
//
// No engine imports: this file is its own entry point in the compiled binary
// (script/build.ts).
import { Database } from "bun:sqlite"
import type { ReadWorkerReply, ReadWorkerRequest } from "./read-runner"

declare const self: Worker

self.onmessage = (event: MessageEvent<ReadWorkerRequest>) => {
  const { file, statements } = event.data
  let db: Database | undefined
  try {
    db = new Database(file, { readonly: true })
    // The engine's connection may hold the write lock for one range of a prune.
    db.run("PRAGMA busy_timeout = 5000")
    // One statement after another, each in its own read, as on the engine's
    // connection: no read snapshot is held for the whole (seconds long) walk.
    const rows = statements.map((statement) => db!.query(statement).get() ?? undefined)
    self.postMessage({ type: "done", rows } satisfies ReadWorkerReply)
  } catch (error) {
    self.postMessage({
      type: "failed",
      error: error instanceof Error ? error.message : String(error),
    } satisfies ReadWorkerReply)
  } finally {
    db?.close()
  }
}
