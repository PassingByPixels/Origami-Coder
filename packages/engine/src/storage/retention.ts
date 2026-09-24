export * as StorageRetention from "./retention"

import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@origami/core/database/database"

/**
 * Session-store retention: measure the store, and compact old tool payloads out
 * of it.
 *
 * Measured on the owner's store 2026-09-21: 15.6 GB total = event journal
 * 10.9 GB + part 3.26 GB (tool parts 2.88 GB, of which attachments 1.96 GB) +
 * message 0.72 GB. The journal holds its own copy of every part payload
 * (`message.part.updated.1`), so the reclaim here is bounded by the part table.
 * The journal is KEPT on the owner's instruction - it is the base for
 * multi-device sync - so this module never touches `event`, `message`,
 * `session` or a title.
 *
 * A prune is a REWRITE, never a delete: the tool part keeps its row, its input,
 * its title and its call id, and its output becomes the same marker automatic
 * compaction leaves (`session/compaction.ts` sets `state.time.compacted`;
 * `session/message-v2.ts` renders `MARKER` for any part carrying it). A restored
 * chat therefore shows a placeholder where the payload was, exactly as a
 * compacted turn does.
 */

/** What `message-v2.ts` already renders for a compacted tool part. Written into
 *  the row so a UI reading `state.output` directly shows the same words. */
export const MARKER = "[Old tool result content cleared]"

/** Messages at the tail of a session are what a resume replays and what the next
 *  turn re-reads, so they are never pruned however old the session is. */
export const KEEP_RECENT_MESSAGES = 20

/** The floor on a window. A UI bug that sends 0 must not be able to erase the
 *  output of work done this morning. */
export const MIN_WINDOW_DAYS = 7

export const DEFAULT_WINDOW_DAYS = 60

/** Same protection `session/compaction.ts`'s prune applies: a skill's output is
 *  the instruction set a later turn still reads back. */
const PROTECTED_TOOLS = ["skill"]

const MS_IN_DAY = 24 * 60 * 60 * 1000

export type PartSplit = {
  readonly total: number
  readonly toolOutput: number
  readonly images: number
  readonly other: number
}

export type Stats = {
  /** `page_count * page_size` - the file on disk, including free pages. */
  readonly fileBytes: number
  readonly journalBytes: number
  readonly messageBytes: number
  readonly parts: PartSplit
  readonly counts: {
    readonly events: number
    readonly messages: number
    readonly parts: number
    readonly sessions: number
  }
  /** Named so the card can say what the numbers ARE. `length()` over the stored
   *  JSON is a character count of the payload, not the page bytes SQLite spends
   *  on it; `dbstat` would give the latter but is not compiled into the SQLite
   *  this engine links. The file total above is exact. */
  readonly method: "length-sums"
  readonly measuredMs: number
}

export type PruneResult = {
  readonly dryRun: boolean
  readonly olderThanDays: number
  /** Epoch ms; every part older than this was considered. */
  readonly cutoff: number
  readonly parts: number
  readonly toolOutputBytes: number
  readonly imageBytes: number
  readonly bytes: number
  /** Row counts after the pass. They are the proof the rewrite deleted nothing:
   *  a prune that moved any of these is a defect, not a retention policy. */
  readonly rows: {
    readonly events: number
    readonly messages: number
    readonly parts: number
  }
}

/** Every part the window admits, minus the tail each session keeps, minus the
 *  ones already pruned. Shared by the dry run and the write so the count a user
 *  confirms is the count that is written. */
function candidates(cutoff: number) {
  return sql`
    ${sql.identifier("part")}.time_created < ${cutoff}
    AND json_extract(${sql.identifier("part")}.data, '$.type') = 'tool'
    AND json_extract(${sql.identifier("part")}.data, '$.state.status') = 'completed'
    AND coalesce(json_extract(${sql.identifier("part")}.data, '$.tool'), '') NOT IN (${sql.join(
      PROTECTED_TOOLS.map((tool) => sql`${tool}`),
      sql`, `,
    )})
    AND (
      coalesce(json_extract(${sql.identifier("part")}.data, '$.state.output'), '') NOT IN ('', ${MARKER})
      OR json_extract(${sql.identifier("part")}.data, '$.state.attachments') IS NOT NULL
    )
    AND ${sql.identifier("part")}.message_id NOT IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (
          PARTITION BY session_id ORDER BY time_created DESC, id DESC
        ) AS rn FROM ${sql.identifier("message")}
      ) WHERE rn <= ${KEEP_RECENT_MESSAGES}
    )
  `
}

const rowCounts = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const row = yield* db
    .get<{ events: number; messages: number; parts: number }>(
      sql`SELECT
        (SELECT count(*) FROM ${sql.identifier("event")}) AS events,
        (SELECT count(*) FROM ${sql.identifier("message")}) AS messages,
        (SELECT count(*) FROM ${sql.identifier("part")}) AS parts`,
    )
    .pipe(Effect.orDie)
  return { events: row?.events ?? 0, messages: row?.messages ?? 0, parts: row?.parts ?? 0 }
})

export const stats = Effect.fn("StorageRetention.stats")(function* () {
  const { db } = yield* Database.Service
  const started = Date.now()
  const page = yield* db
    .get<{ page_count: number; page_size: number }>(
      sql`SELECT (SELECT * FROM pragma_page_count()) AS page_count, (SELECT * FROM pragma_page_size()) AS page_size`,
    )
    .pipe(Effect.orDie)
  const journal = yield* db
    .get<{ b: number | null }>(sql`SELECT sum(length(data)) AS b FROM ${sql.identifier("event")}`)
    .pipe(Effect.orDie)
  const messages = yield* db
    .get<{ b: number | null }>(sql`SELECT sum(length(data)) AS b FROM ${sql.identifier("message")}`)
    .pipe(Effect.orDie)
  // One pass over `part` for the whole split: the table is gigabytes, and three
  // passes would be three full scans for numbers that come from the same rows.
  const parts = yield* db
    .get<{ total: number | null; tool_output: number | null; images: number | null }>(
      sql`SELECT
        sum(length(data)) AS total,
        sum(CASE WHEN json_extract(data, '$.type') = 'tool'
          THEN length(coalesce(json_extract(data, '$.state.output'), '')) ELSE 0 END) AS tool_output,
        sum(CASE
          WHEN json_extract(data, '$.type') = 'tool'
            THEN length(coalesce(json_extract(data, '$.state.attachments'), ''))
          WHEN json_extract(data, '$.type') = 'file' THEN length(data)
          ELSE 0 END) AS images
        FROM ${sql.identifier("part")}`,
    )
    .pipe(Effect.orDie)
  const counts = yield* rowCounts()
  const sessions = yield* db
    .get<{ n: number }>(sql`SELECT count(*) AS n FROM ${sql.identifier("session")}`)
    .pipe(Effect.orDie)
  const total = parts?.total ?? 0
  const toolOutput = parts?.tool_output ?? 0
  const images = parts?.images ?? 0
  return {
    fileBytes: (page?.page_count ?? 0) * (page?.page_size ?? 0),
    journalBytes: journal?.b ?? 0,
    messageBytes: messages?.b ?? 0,
    parts: { total, toolOutput, images, other: Math.max(0, total - toolOutput - images) },
    counts: { ...counts, sessions: sessions?.n ?? 0 },
    method: "length-sums",
    measuredMs: Date.now() - started,
  } satisfies Stats
})

/**
 * Compact old tool payloads. `dryRun` measures and writes nothing.
 *
 * The rewrite is one UPDATE rather than a read-modify-write loop: the payloads
 * are the thing being removed, so pulling 2.8 GB of them through the process to
 * decide that is the wrong shape. It writes the part table DIRECTLY, not through
 * `Session.updatePart`, on purpose: an update goes through the event log, and
 * publishing one event per pruned part would add a fresh copy of the work to the
 * journal - the largest table here, and the one the owner keeps. A projector
 * runs only at commit time (`core/session/projector.ts`), never as a replay, so
 * nothing re-derives these rows from the journal afterwards.
 *
 * It is ONE statement, so it holds the write lock for as long as it runs: the
 * measuring scan over 345k parts took ~6 s on the owner's store, and the engine
 * opens the database with `busy_timeout = 5000`. A turn writing a part during a
 * large prune can therefore wait, and a very large one could make it wait too
 * long. That is why this is a manual, confirmed action and not a schedule; if it
 * ever becomes automatic, batch it by rowid first.
 *
 * VACUUM is NOT run: it rewrites the entire file (15.6 GB on the owner's box)
 * into a new one, needs that much free space again, and locks the store while it
 * does. The freed pages are reused by the next writes instead; the file total in
 * `stats` is the number that will not move until someone vacuums deliberately.
 */
export const prune = Effect.fn("StorageRetention.prune")(function* (input: {
  olderThanDays: number
  dryRun: boolean
}) {
  const { db } = yield* Database.Service
  const olderThanDays = Math.max(MIN_WINDOW_DAYS, Math.floor(input.olderThanDays))
  const cutoff = Date.now() - olderThanDays * MS_IN_DAY
  const measured = yield* db
    .get<{ n: number; out_bytes: number | null; img_bytes: number | null }>(
      sql`SELECT
        count(*) AS n,
        sum(length(coalesce(json_extract(${sql.identifier("part")}.data, '$.state.output'), ''))) AS out_bytes,
        sum(length(coalesce(json_extract(${sql.identifier("part")}.data, '$.state.attachments'), ''))) AS img_bytes
        FROM ${sql.identifier("part")} WHERE ${candidates(cutoff)}`,
    )
    .pipe(Effect.orDie)
  const parts = measured?.n ?? 0
  const toolOutputBytes = Math.max(0, (measured?.out_bytes ?? 0) - parts * MARKER.length)
  const imageBytes = measured?.img_bytes ?? 0
  if (!input.dryRun && parts > 0) {
    yield* db
      .run(
        sql`UPDATE ${sql.identifier("part")} SET data = json_set(
          json_remove(data, '$.state.attachments'),
          '$.state.output', ${MARKER},
          '$.state.time.compacted', ${Date.now()}
        ) WHERE ${candidates(cutoff)}`,
      )
      .pipe(Effect.orDie)
  }
  return {
    dryRun: input.dryRun,
    olderThanDays,
    cutoff,
    parts,
    toolOutputBytes,
    imageBytes,
    bytes: toolOutputBytes + imageBytes,
    rows: yield* rowCounts(),
  } satisfies PruneResult
})
