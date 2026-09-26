import type { Database } from "@origami/core/database/database"
import { Effect } from "effect"
import { SessionDegrade } from "./degrade"
import { SessionImageCap } from "./image-cap"
import { SessionRequestMemoryRows } from "./request-memory-rows"
import { SessionToolAging } from "./tool-aging"
import { SessionWindowFit } from "./window-fit"

/**
 * SESSION REQUEST MEMORY (t-w2qb1x): what this engine decided about a
 * session's requests, kept in SQLite so a restarted engine sends the bytes the
 * same engine would have sent without the restart.
 *
 * The decisions are taken in process memory, which stays the cache: tool-aging
 * rewrites and reprieves (tool-aging.ts), refused knobs (degrade.ts), a learned
 * image cap (image-cap.ts), the window-fit ratio (window-fit.ts). Each store
 * queues a row when it decides (request-memory-rows.ts); `flush` writes the
 * queue before the request that carries the decision goes out, so a decision
 * that reached the wire is on disk. t-wdyp7r: it also writes at every step end
 * (the ratio learned from a reply, processor.ts) and at every turn end
 * (prompt.ts). So an idle session, the only kind a park stops or a close
 * frees, has nothing queued unless a write failed. `ensure` loads a session's
 * rows into every store that does not hold the session: after a restart, and after a store's
 * LRU dropped it. The `tool_search` loaded set is the fifth kind; it lives in
 * the ToolSearch service, which reads and writes its own rows.
 *
 * Rows are deleted with the session (foreign key, ON DELETE CASCADE).
 */

type Db = Database.Interface["db"]

/**
 * Write what this process queued for `sessionID`. Nothing queued costs one map
 * lookup. A failed write is logged and dropped rather than failing the turn:
 * the request still goes out, and only a later restart of this session loses
 * the decision (the old behaviour).
 */
export const flush = Effect.fnUntraced(function* (db: Db, sessionID: string) {
  const rows = SessionRequestMemoryRows.take(sessionID)
  if (rows.length === 0) return
  yield* SessionRequestMemoryRows.write(db, sessionID, rows).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("session request memory not written", { "session.id": sessionID, rows: rows.length, cause }),
    ),
  )
})

const stores = [SessionToolAging, SessionDegrade, SessionImageCap, SessionWindowFit] as const

/**
 * Make every store hold `sessionID`, from the database, if one does not. A
 * store that already holds it is left alone: its memory is newer than or equal
 * to the rows. Rows still queued in this process count as written, and come
 * after the stored ones, so the newest value of a one-value kind is the last.
 *
 * Answers whether every store holds the session afterwards. False only after a
 * failed read: then a caller must not take a decision that builds on the
 * stored ones (t-wdyp7r: a tool-aging plan from scratch, written on top of the
 * stored rows, left a set on disk that no process ever sent).
 */
export const ensure = Effect.fnUntraced(function* (db: Db, sessionID: string) {
  if (stores.every((store) => store.has(sessionID))) return true
  // A miss is the rare path (a restart, a close, an LRU), so the rows of parts
  // that are gone are dropped here, where they would otherwise be read again.
  yield* SessionRequestMemoryRows.prune(db, sessionID).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("session request memory not pruned", { "session.id": sessionID, cause }),
    ),
  )
  const stored = yield* SessionRequestMemoryRows.load(db, sessionID).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("session request memory not read", { "session.id": sessionID, cause }).pipe(
        Effect.as(undefined),
      ),
    ),
  )
  // Unread is not "nothing stored": restore nothing, so the next call reads again.
  if (!stored) return false
  const rows = [...stored, ...SessionRequestMemoryRows.peek(sessionID)]
  for (const store of stores) store.restore(sessionID, rows)
  return true
})

export * as SessionRequestMemory from "./request-memory"
