import type { Database } from "@origami/core/database/database"
import { MessageTable, PartTable } from "@origami/core/session/sql"
import { and, desc, eq, gt, sql } from "drizzle-orm"
import { Effect } from "effect"
import { SessionPromptCapture } from "./prompt-capture"
import { SessionRequestMemoryRows } from "./request-memory-rows"
import type { PartID } from "./schema"

/**
 * RESTORE PREFIX (t-w2txb2): the first request a session sends in a new engine
 * process is compared with the last request the database holds for it, so a
 * cache miss caused by a change while the engine was stopped is named as one
 * rather than read as `cold`.
 *
 * The last request is the newest `step-finish` part of the session that carries
 * a `prefix`, the time it was written, and the model of its assistant message.
 * Read once per session per process (`SessionPromptCapture.needsSeed`); a failed
 * read is logged and leaves no seed, so the request reads `cold` as before.
 *
 * t-wdyp7r: only a step-finish THIS store's engine wrote is a seed. The engine
 * keeps a `restore.seed` row (session request memory, local to the store) that
 * names its newest step-finish with a prefix. A step-finish that came in a
 * Nests journal from another desk, or that a fork copied from its parent, is
 * not the one the row names (or there is no row), and the request reads `cold`
 * as before: another desk's instructions and env are not an edit made while
 * stopped, and a fork never sent a request.
 */

/** The `restore.seed` row: the step-finish this engine wrote last, and the
 *  facts of its request that the part does not carry. */
export type Mark = {
  readonly part: string
  /** `RequestFacts.stable`: the system digest with the date line masked. */
  readonly stable?: string
  readonly agent?: string
}

const isMark = (value: unknown): value is Mark =>
  typeof value === "object" && value !== null && typeof (value as { part?: unknown }).part === "string"

/**
 * Queue the mark for the step-finish `partID` this engine just wrote with a
 * prefix. The step end writes it (`SessionRequestMemory.flush`, processor.ts).
 */
export function mark(sessionID: string, partID: string): void {
  const facts = SessionPromptCapture.lastRequest(sessionID)
  const data: Mark = {
    part: partID,
    ...(facts ? { stable: facts.stable } : {}),
    ...(facts?.agent === undefined ? {} : { agent: facts.agent }),
  }
  SessionRequestMemoryRows.stage(sessionID, [{ kind: "restore.seed", key: "", data }])
}

type Db = Database.Interface["db"]

/** The newest messages a stored step-finish is looked for in. The last request of a chat
 *  is in its newest assistant message; walking every part of a big chat instead read
 *  3,933 parts' JSON in 139-588 ms on the owner's largest chat (measured read-only,
 *  2026-09-25), against 0.2-2 ms for this bound. None found = no seed (`cold`, as before). */
const NEWEST_MESSAGES = 20

const newest = (sessionID: string) =>
  sql`${PartTable.message_id} IN (SELECT id FROM message WHERE session_id = ${sessionID} ORDER BY time_created DESC, id DESC LIMIT ${NEWEST_MESSAGES})`

const last = (db: Db, sessionID: string) =>
  db
    .select({ id: PartTable.id, data: PartTable.data, time: PartTable.time_created, message: MessageTable.data })
    .from(PartTable)
    .innerJoin(MessageTable, eq(MessageTable.id, PartTable.message_id))
    .where(
      and(
        newest(sessionID),
        sql`json_extract(${PartTable.data}, '$.type') = 'step-finish'`,
        sql`json_extract(${PartTable.data}, '$.prefix.system') IS NOT NULL`,
      ),
    )
    .orderBy(desc(PartTable.id))
    .limit(1)
    .get()

/** Whether a compaction was started after the part `partID` (written at `time`).
 *  Part ids ascend with time, so "after" is a comparison of ids; only the messages
 *  written since are read (0.1 ms against 131 ms for the whole chat, same measurement). */
const compactedSince = (db: Db, sessionID: string, partID: string, time: number) =>
  db
    .select({ id: PartTable.id })
    .from(PartTable)
    .where(
      and(
        sql`${PartTable.message_id} IN (SELECT id FROM message WHERE session_id = ${sessionID} AND time_created >= ${time})`,
        gt(PartTable.id, partID as PartID),
        sql`json_extract(${PartTable.data}, '$.type') = 'compaction'`,
      ),
    )
    .limit(1)
    .get()

function toSeed(
  row: {
    readonly data: unknown
    readonly time: number
    readonly message: unknown
  },
  marked: Mark,
): SessionPromptCapture.Seed | undefined {
  const prefix = (row.data as { prefix?: { system?: unknown; tools?: unknown; history?: unknown } }).prefix
  const message = row.message as { providerID?: unknown; modelID?: unknown }
  if (typeof prefix?.system !== "string" || typeof prefix.tools !== "string") return undefined
  if (typeof message.providerID !== "string" || typeof message.modelID !== "string") return undefined
  return {
    prefix: {
      system: prefix.system,
      tools: prefix.tools,
      ...(typeof prefix.history === "string" ? { history: prefix.history } : {}),
    },
    at: row.time,
    model: `${message.providerID}/${message.modelID}`,
    ...(marked.stable === undefined ? {} : { stable: marked.stable }),
    ...(marked.agent === undefined ? {} : { agent: marked.agent }),
  }
}

/** Seed the prompt capture for `sessionID` from the database, if it needs one. */
export const ensure = Effect.fnUntraced(function* (db: Db, sessionID: string) {
  if (!SessionPromptCapture.needsSeed(sessionID)) return
  const found = yield* Effect.gen(function* () {
    const row = yield* last(db, sessionID)
    if (!row) return undefined
    // Queued rows are newer than stored ones (a write that failed at the step end).
    const marked = [
      ...(yield* SessionRequestMemoryRows.load(db, sessionID, "restore.seed")),
      ...SessionRequestMemoryRows.peek(sessionID).filter((item) => item.kind === "restore.seed"),
    ].at(-1)?.data
    const value = isMark(marked) && marked.part === row.id ? toSeed(row, marked) : undefined
    if (!value) return undefined
    return { value, compacted: (yield* compactedSince(db, sessionID, row.id, row.time)) !== undefined }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("restore prefix not read", { "session.id": sessionID, cause }).pipe(Effect.as(undefined)),
    ),
  )
  SessionPromptCapture.seed(sessionID, found?.value)
  // The compaction mark is process memory: a compaction that ran before the
  // stop must still explain the miss after it, as it would have without one.
  if (found?.compacted) SessionPromptCapture.markCompacted(sessionID)
})

export * as SessionRestorePrefix from "./restore-prefix"
