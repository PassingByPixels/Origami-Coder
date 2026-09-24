export * as StorageJournal from "./journal"

import { Effect } from "effect"
import { sql, type SQL } from "drizzle-orm"
import { statfsSync } from "node:fs"
import { dirname } from "node:path"
import { Database } from "@origami/core/database/database"

/**
 * Journal compaction, and the one-time VACUUM that turns it into free disk.
 *
 * The `event` table holds one row per state change. A part is rewritten IN FULL
 * on every change, so a streamed answer wrote its own text again for every few
 * words: 13,489 `message.part.updated` rows for 1,033 parts in the largest
 * session measured on the owner's store (418 MB of events for 7.1 MB of final
 * parts, 2026-09-22). Compaction keeps, per part, only the state that survived.
 *
 * The rule, and why each family differs:
 *
 * - `message.part.updated` collapses to the LAST row of a part id, placed at the
 *   FIRST row's position. Its projector is an upsert (`insert ... on conflict do
 *   update set data`), so only the last payload can be observed, and position
 *   does not change what it writes. The collapsed row carries the FIRST row's
 *   `$.time`, because the part row's `time_created` is set on insert from that
 *   field and nothing later overwrites it.
 * - `message.updated` collapses the same way, grouped by message id AND
 *   `$.info.time.created`: the projector takes the message row's `time_created`
 *   from the payload on insert, so a group is only safe to merge while that
 *   value is constant.
 * - `session.updated` keeps the LAST row AT ITS OWN position, and drops the
 *   earlier ones. Its projector writes the whole session row (`sessionRow`),
 *   including `cost` and the token counters that `message.part.updated` on a
 *   `step-finish` part INCREMENTS. Moving a full overwrite earlier past an
 *   increment would change the total; leaving it where it is cannot.
 *
 * Three exclusions, each a class of divergence rather than one case:
 *
 * - `step-finish` parts are never collapsed. Their projector is incremental
 *   (subtract the row's old usage, add the new), so a group's contribution
 *   depends on the row state at each step, not only on the last payload.
 * - a part id with a `message.part.removed` row, or a message id with a
 *   `message.removed` row, is never collapsed: moving a later state before the
 *   removal would resurrect a row the original replay deletes.
 * - a session whose `event_sequence.owner_id` is set is skipped. Compaction
 *   renumbers sequences (see below) and that session's journal has been handed
 *   to another engine, which resumes by sequence number.
 *
 * WHY SEQUENCES ARE RENUMBERED. The ticket's rule is "the last row at the first
 * row's seq", which leaves holes. `EventV2.replayAll` refuses a batch whose
 * sequences are not contiguous, and `commitDurableEvent` dies unless each
 * replayed seq is exactly `latest + 1` - and the workspace warp path
 * (`control-plane/workspace.ts`) replays a session's whole journal in chunks of
 * ten through exactly that check. A journal with holes could therefore not be
 * replayed at all, which is the property the ticket asks to be proven. So the
 * surviving rows keep their ORDER and their relative position, and are then
 * numbered 0..n-1. Renumbering is order-preserving, so every stored sequence
 * that is only ever compared with another stored sequence (`session_message.seq`
 * against a revert boundary, `session_input.promoted_seq`) still selects the
 * same rows.
 */

/** A group of journal rows that collapses to one. `first`/`last` are sequence
 *  numbers in the ORIGINAL numbering. */
type Group = {
  /** The value the family is grouped by - a part id, a message id, a session id. */
  readonly key: string
  readonly firstSeq: number
  readonly lastSeq: number
  readonly n: number
  readonly groupBytes: number
  readonly keepBytes: number
}

export type CompactionResult = {
  readonly dryRun: boolean
  /** Sessions that were eligible and looked at. */
  readonly sessions: number
  /** Of those, the ones with something to collapse. */
  readonly compacted: number
  readonly skipped: {
    /** An assistant message with no `time.completed`: a turn may still be running. */
    readonly running: number
    /** `event_sequence.owner_id` is set - another engine holds this journal. */
    readonly owned: number
  }
  readonly events: { readonly before: number; readonly after: number }
  readonly bytes: { readonly before: number; readonly after: number }
}

export type VacuumResult = {
  readonly ran: boolean
  /** Why it did not run, when it did not. `in-use`: another connection (another
   *  engine, so another window) has the store open. */
  readonly refused?: "unconfirmed" | "free-space" | "in-use"
  readonly fileBytes: number
  readonly freeBytes: number
  /** What the check demanded: `fileBytes * FREE_SPACE_FACTOR`. */
  readonly requiredBytes: number
  readonly reclaimedBytes: number
  readonly elapsedMs: number
}

/** VACUUM writes a second copy of the whole file before it swaps: the store was
 *  15.7 GB when this was written, so "enough room" is not the file size but the
 *  file size with headroom for the WAL and for the store still being written. */
export const FREE_SPACE_FACTOR = 1.5

const PART_UPDATED = "message.part.updated.%"
const MESSAGE_UPDATED = "message.updated.%"
const SESSION_UPDATED = "session.updated.%"

/** Sessions with no running turn and no other owner, newest journal first. */
const eligible = Effect.fnUntraced(function* (sessionID?: string) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .all<{ aggregate_id: string; owned: number; running: number }>(
      sql`SELECT s.aggregate_id,
            (s.owner_id IS NOT NULL) AS owned,
            EXISTS (SELECT 1 FROM ${sql.identifier("message")} m
              WHERE m.session_id = s.aggregate_id
                AND json_extract(m.data, '$.role') = 'assistant'
                AND json_extract(m.data, '$.time.completed') IS NULL) AS running
          FROM ${sql.identifier("event_sequence")} s
          ${sessionID ? sql`WHERE s.aggregate_id = ${sessionID}` : sql``}`,
    )
    .pipe(Effect.orDie)
  return rows
})

/** The collapsible groups of one family, read WITHOUT pulling any payload into
 *  this process: the payloads are the gigabytes being removed. */
const groups = Effect.fnUntraced(function* (input: {
  readonly aggregateID: string
  readonly type: string
  readonly key: SQL
  readonly extra: SQL | undefined
  readonly above: number
}) {
  const { db } = yield* Database.Service
  return yield* db
    .all<Group>(
      sql`SELECT g.k AS "key", g.f AS "firstSeq", g.l AS "lastSeq", g.c AS "n",
            g.b AS "groupBytes", length(e.data) AS "keepBytes"
          FROM (
            SELECT ${input.key} AS k, min(seq) AS f, max(seq) AS l,
                   count(*) AS c, sum(length(data)) AS b
            FROM ${sql.identifier("event")}
            WHERE aggregate_id = ${input.aggregateID} AND type LIKE ${input.type} AND seq > ${input.above}
              ${input.extra ?? sql``}
            GROUP BY k HAVING count(*) > 1
          ) g
          JOIN ${sql.identifier("event")} e
            ON e.aggregate_id = ${input.aggregateID} AND e.seq = g.l`,
    )
    .pipe(Effect.orDie)
})

/** Part ids and message ids this session must not collapse, as SQL fragments the
 *  group query can paste in. A removal in the journal means a later state moved
 *  before it would resurrect a deleted row. */
const removalGuards = (aggregateID: string) => ({
  parts: sql`AND json_extract(data, '$.part.id') NOT IN (
      SELECT json_extract(data, '$.partID') FROM ${sql.identifier("event")}
      WHERE aggregate_id = ${aggregateID} AND type LIKE 'message.part.removed.%')
    AND json_extract(data, '$.part.messageID') NOT IN (
      SELECT json_extract(data, '$.messageID') FROM ${sql.identifier("event")}
      WHERE aggregate_id = ${aggregateID} AND type LIKE 'message.removed.%')
    AND json_extract(data, '$.part.type') <> 'step-finish'`,
  messages: sql`AND json_extract(data, '$.info.id') NOT IN (
      SELECT json_extract(data, '$.messageID') FROM ${sql.identifier("event")}
      WHERE aggregate_id = ${aggregateID} AND type LIKE 'message.removed.%')`,
})

/** The survivor of one group takes the last row's payload, and keeps its own
 *  `$.time` when the family needs it.
 *
 *  Both rows are addressed by (aggregate, seq) AND by family and key
 *  (t-tc2193): a group that does not match the journal any more finds no
 *  source row, and the UPDATE ... FROM then writes nothing, instead of one
 *  row's payload (or NULL) into another row. */
const survive = Effect.fnUntraced(function* (input: {
  readonly aggregateID: string
  readonly type: string
  readonly key: SQL
  readonly group: Group
  readonly keepTime: boolean
}) {
  const { db } = yield* Database.Service
  yield* db
    .run(
      sql`UPDATE ${sql.identifier("event")} SET data = ${
        input.keepTime ? sql`json_set(src.payload, '$.time', json_extract(data, '$.time'))` : sql`src.payload`
      }
          FROM (SELECT data AS payload FROM ${sql.identifier("event")}
                WHERE aggregate_id = ${input.aggregateID} AND seq = ${input.group.lastSeq}
                  AND type LIKE ${input.type} AND ${input.key} = ${input.group.key}) AS src
          WHERE aggregate_id = ${input.aggregateID} AND seq = ${input.group.firstSeq}
            AND type LIKE ${input.type} AND ${input.key} = ${input.group.key}`,
    )
    .pipe(Effect.orDie)
})

/** The rest of every group of one family goes, in ONE statement. Every row of a
 *  grouped key above `above` lies between its group's first and last seq, so
 *  "grouped key, not a survivor" is the same set as each group's range. One
 *  statement reads each row once; a DELETE per group read the whole range of
 *  each group again, which held the write lock for minutes on a large session
 *  (t-tc2193, measured: 14,000 rows / 366 MB, about 134 s before and 2.5 s
 *  after). */
const drop = Effect.fnUntraced(function* (input: {
  readonly aggregateID: string
  readonly type: string
  readonly key: SQL
  readonly groups: ReadonlyArray<Group>
  readonly above: number
}) {
  if (input.groups.length === 0) return
  const { db } = yield* Database.Service
  yield* db
    .run(
      sql`DELETE FROM ${sql.identifier("event")}
          WHERE aggregate_id = ${input.aggregateID} AND seq > ${input.above} AND type LIKE ${input.type}
            AND seq NOT IN (SELECT value FROM json_each(${JSON.stringify(input.groups.map((group) => group.firstSeq))}))
            AND ${input.key} IN (SELECT value FROM json_each(${JSON.stringify(input.groups.map((group) => group.key))}))`,
    )
    .pipe(Effect.orDie)
})

/**
 * Compact one session's journal. `dryRun` measures and writes nothing.
 *
 * `sessionID` limits the pass to one session; without it every eligible session
 * is compacted. The whole pass runs as one transaction per session, so an
 * interrupted run leaves whole sessions done and the rest untouched, never a
 * half-renumbered journal.
 *
 * `above` (Nests L5, t-sb9tlk) compacts only the TAIL: rows with a seq above it.
 * The caller passes the highest seq any other desk can hold (the last seq it
 * exported, or the seq it took the session over at). Rows at or below it keep
 * their payload and their seq, so a receiver that resumes from them cannot
 * diverge; that is why the owner check is skipped for a tail pass. Groups are
 * formed from tail rows only, and the tail is renumbered from `above + 1`.
 *
 * CONCURRENCY (t-tc2193). A write pass re-reads the session's owner and running
 * state, builds its plan and applies it inside ONE `BEGIN IMMEDIATE`
 * transaction: another pass (a second export, a Manager Compact, another
 * engine) cannot renumber the journal between the plan and the write. A caller
 * that passes `above` must read it inside the same write transaction (see
 * `StorageNests.exportChunk`), or the mark can be stale too.
 */
export const compact = Effect.fn("StorageJournal.compact")(function* (input: {
  readonly dryRun: boolean
  readonly sessionID?: string
  readonly above?: number
}) {
  const above = input.above ?? -1
  const { db } = yield* Database.Service
  const measure = (aggregateID: string) =>
    db
      .get<{ n: number; b: number | null }>(
        sql`SELECT count(*) AS n, sum(length(data)) AS b
            FROM ${sql.identifier("event")} WHERE aggregate_id = ${aggregateID}`,
      )
      .pipe(Effect.orDie)
  const totals = { sessions: 0, compacted: 0, running: 0, owned: 0, before: 0, after: 0, rowsBefore: 0, rowsAfter: 0 }
  const partKey = sql`json_extract(data, '$.part.id')`
  const messageKey = sql`json_extract(data, '$.info.id') || '@' || coalesce(json_extract(data, '$.info.time.created'), '')`
  /** One session: its state, its plan and (unless a dry run) the write. A write
   *  pass runs this whole function inside its IMMEDIATE transaction. */
  const pass = Effect.fnUntraced(function* (aggregateID: string) {
    const [row] = yield* eligible(aggregateID)
    if (!row) return
    if (row.owned && input.above === undefined) {
      totals.owned++
      return
    }
    if (row.running) {
      totals.running++
      return
    }
    totals.sessions++
    const guards = removalGuards(aggregateID)
    const plan = {
      parts: yield* groups({ aggregateID, type: PART_UPDATED, key: partKey, extra: guards.parts, above }),
      messages: yield* groups({ aggregateID, type: MESSAGE_UPDATED, key: messageKey, extra: guards.messages, above }),
      // One group for the whole session: every row but the last goes, and the
      // last one does NOT move.
      sessions: yield* groups({ aggregateID, type: SESSION_UPDATED, key: sql`aggregate_id`, extra: undefined, above }),
    }
    const before = yield* measure(aggregateID)
    totals.rowsBefore += before?.n ?? 0
    totals.before += before?.b ?? 0
    const dropped = [...plan.parts, ...plan.messages, ...plan.sessions]
    if (dropped.length === 0) {
      totals.rowsAfter += before?.n ?? 0
      totals.after += before?.b ?? 0
      return
    }
    totals.compacted++
    if (input.dryRun) {
      totals.rowsAfter += (before?.n ?? 0) - dropped.reduce((sum, group) => sum + group.n - 1, 0)
      totals.after += (before?.b ?? 0) - dropped.reduce((sum, group) => sum + group.groupBytes - group.keepBytes, 0)
      return
    }
    for (const group of plan.parts)
      yield* survive({ aggregateID, type: PART_UPDATED, key: partKey, group, keepTime: true })
    yield* drop({ aggregateID, type: PART_UPDATED, key: partKey, groups: plan.parts, above })
    for (const group of plan.messages)
      yield* survive({ aggregateID, type: MESSAGE_UPDATED, key: messageKey, group, keepTime: false })
    yield* drop({ aggregateID, type: MESSAGE_UPDATED, key: messageKey, groups: plan.messages, above })
    // The last `session.updated` stays where it is, so this one only
    // deletes - no payload is moved.
    for (const group of plan.sessions)
      yield* db
        .run(
          sql`DELETE FROM ${sql.identifier("event")}
              WHERE aggregate_id = ${aggregateID} AND type LIKE ${SESSION_UPDATED}
                AND seq < ${group.lastSeq} AND seq > ${above}`,
        )
        .pipe(Effect.orDie)
    // Two passes, because `(aggregate_id, seq)` is unique: shifting every
    // row out of the target range first means no intermediate collision.
    yield* db
      .run(
        sql`UPDATE ${sql.identifier("event")} SET seq = seq + 1000000000 WHERE aggregate_id = ${aggregateID} AND seq > ${above}`,
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`UPDATE ${sql.identifier("event")} SET seq = r.rn
            FROM (SELECT id, row_number() OVER (ORDER BY seq) + ${above} AS rn
                  FROM ${sql.identifier("event")} WHERE aggregate_id = ${aggregateID} AND seq > ${above}) AS r
            WHERE ${sql.identifier("event")}.id = r.id`,
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`UPDATE ${sql.identifier("event_sequence")}
            SET seq = (SELECT max(seq) FROM ${sql.identifier("event")} WHERE aggregate_id = ${aggregateID})
            WHERE aggregate_id = ${aggregateID}`,
      )
      .pipe(Effect.orDie)
    const after = yield* measure(aggregateID)
    totals.rowsAfter += after?.n ?? 0
    totals.after += after?.b ?? 0
  })
  // The list is only the candidates: `pass` reads each one's state again, in the
  // transaction that writes it.
  for (const row of yield* eligible(input.sessionID)) {
    if (input.dryRun) yield* pass(row.aggregate_id)
    else yield* db.transaction(() => pass(row.aggregate_id), { behavior: "immediate" }).pipe(Effect.orDie)
  }
  return {
    dryRun: input.dryRun,
    sessions: totals.sessions,
    compacted: totals.compacted,
    skipped: { running: totals.running, owned: totals.owned },
    events: { before: totals.rowsBefore, after: totals.rowsAfter },
    bytes: { before: totals.before, after: totals.after },
  } satisfies CompactionResult
})

/**
 * VACUUM the store. NEVER automatic, and never the tail of a compaction: it
 * rewrites the entire file into a new one, needs that much free space again, and
 * holds the store while it does. Compaction frees pages INSIDE the file; only
 * this returns them to the disk.
 *
 * Three refusals, all before anything is written: no `confirm`, less free
 * space than `FREE_SPACE_FACTOR` times the file, or `in-use`. A refusal is a
 * RESULT, not an error - the card that offers the button shows the same numbers
 * either way.
 *
 * `in-use` (t-tc2193): VACUUM holds the store for as long as it rewrites it -
 * minutes on a large store, far past the 5 s busy_timeout of every other
 * engine. So it runs only under SQLite's EXCLUSIVE locking mode, which a WAL
 * store grants only while no other connection has the file open. With another
 * engine open the answer is a refusal (close the other windows first), not
 * minutes of "database is locked" failures in those windows.
 */
/** Back to NORMAL locking: the exclusive lock is dropped at the next read. */
const releaseExclusive = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(sql`PRAGMA locking_mode = NORMAL`).pipe(Effect.orDie)
  yield* db.get(sql`SELECT count(*) FROM sqlite_master`).pipe(Effect.orDie)
})

/** SQLite's EXCLUSIVE locking mode on this engine's connection. False, with the
 *  mode NORMAL again, when another connection has the store open; it does not
 *  wait for one to close (busy_timeout 0 for the attempt). */
const takeExclusive = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const timeout = (yield* db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`).pipe(Effect.orDie))?.timeout ?? 5000
  yield* db.run(sql`PRAGMA busy_timeout = 0`).pipe(Effect.orDie)
  yield* db.run(sql`PRAGMA locking_mode = EXCLUSIVE`).pipe(Effect.orDie)
  // An empty write transaction is what takes the lock; it is then held until
  // the mode is NORMAL again and the store is read once more.
  const took = yield* db.transaction(() => Effect.void, { behavior: "immediate" }).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  )
  yield* db.run(sql.raw(`PRAGMA busy_timeout = ${Number(timeout)}`)).pipe(Effect.orDie)
  if (!took) yield* releaseExclusive
  return took
})

export const vacuum = Effect.fn("StorageJournal.vacuum")(function* (input: { readonly confirm: boolean }) {
  const { db } = yield* Database.Service
  const page = yield* db
    .get<{ page_count: number; page_size: number }>(
      sql`SELECT (SELECT * FROM pragma_page_count()) AS page_count, (SELECT * FROM pragma_page_size()) AS page_size`,
    )
    .pipe(Effect.orDie)
  const fileBytes = (page?.page_count ?? 0) * (page?.page_size ?? 0)
  // The DIRECTORY, not the file: the store may not exist yet, and `:memory:` is
  // not a path at all - `statfs` on either throws ENOENT.
  const file = Database.path()
  const stat = yield* Effect.sync(() => statfsSync(file === ":memory:" ? process.cwd() : dirname(file)))
  const freeBytes = stat.bsize * stat.bavail
  const requiredBytes = Math.ceil(fileBytes * FREE_SPACE_FACTOR)
  const refused: VacuumResult["refused"] = !input.confirm
    ? "unconfirmed"
    : freeBytes < requiredBytes
      ? "free-space"
      : undefined
  const refuse = (reason: NonNullable<VacuumResult["refused"]>): VacuumResult => ({
    ran: false,
    refused: reason,
    fileBytes,
    freeBytes,
    requiredBytes,
    reclaimedBytes: 0,
    elapsedMs: 0,
  })
  if (refused) return refuse(refused)
  if (!(yield* takeExclusive)) return refuse("in-use")
  const started = Date.now()
  yield* db.run(sql`VACUUM`).pipe(Effect.orDie, Effect.ensuring(releaseExclusive))
  const shrunk = yield* db
    .get<{ page_count: number; page_size: number }>(
      sql`SELECT (SELECT * FROM pragma_page_count()) AS page_count, (SELECT * FROM pragma_page_size()) AS page_size`,
    )
    .pipe(Effect.orDie)
  const done: VacuumResult = {
    ran: true,
    fileBytes,
    freeBytes,
    requiredBytes,
    reclaimedBytes: Math.max(0, fileBytes - (shrunk?.page_count ?? 0) * (shrunk?.page_size ?? 0)),
    elapsedMs: Date.now() - started,
  }
  return done
})
