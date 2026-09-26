export * as StorageRetention from "./retention"

import { Effect } from "effect"
import { sql, type SQL } from "drizzle-orm"
import { Database } from "@origami/core/database/database"
import { StorageNestsMeasure } from "./nests-measure"
import { StorageRead } from "./read-runner"

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

/** The candidates of one rowid range of `part`: every part the window admits,
 *  minus the tail each session keeps, minus the ones already pruned. The tail
 *  is read only for the sessions of the range, which gives the same rows as a
 *  tail of every session (the row number counts within a session). The dry run
 *  applies the same rule with the tail (`TAIL`, read once) in JS. */
function candidates(cutoff: number, lo: number, hi: number, huge?: number) {
  const inRange = sql`${sql.identifier("part")}.rowid > ${lo} AND ${sql.identifier("part")}.rowid <= ${hi}`
  const rule = huge === undefined ? admitted(cutoff) : admittedOrHuge(cutoff, huge)
  return sql`${inRange} AND ${rule} AND ${sql.identifier("part")}.message_id NOT IN (
    SELECT id FROM (
      SELECT id, row_number() OVER (
        PARTITION BY session_id ORDER BY time_created DESC, id DESC
      ) AS rn FROM ${sql.identifier("message")}
      WHERE session_id IN (SELECT session_id FROM ${sql.identifier("part")} WHERE ${inRange})
    ) WHERE rn <= ${KEEP_RECENT_MESSAGES})`
}

/** The ids of the last KEEP_RECENT_MESSAGES messages of every session. */
const TAIL = sql`
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY session_id ORDER BY time_created DESC, id DESC
    ) AS rn FROM ${sql.identifier("message")}
  ) WHERE rn <= ${KEEP_RECENT_MESSAGES}`

/** The candidate rule without the tail. */
function admitted(cutoff: number) {
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
  `
}

/** `admitted`, except that a row above `huge` is not parsed: it is admitted
 *  when it is old and its JSON starts with `{"type":"tool"` (the measure's rule). */
function admittedOrHuge(cutoff: number, huge: number) {
  return sql`CASE WHEN octet_length(${sql.identifier("part")}.data) > ${huge}
    THEN ${sql.identifier("part")}.time_created < ${cutoff}
      AND substr(${sql.identifier("part")}.data, 1, 14) = '{"type":"tool"'
    ELSE ${admitted(cutoff)} END`
}

type Measured = { n: number; out_bytes: number; img_bytes: number }

const partTop = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const row = yield* db
    .get<{ top: number | null }>(sql`SELECT max(rowid) AS top FROM ${sql.identifier("part")}`)
    .pipe(Effect.orDie)
  return row?.top ?? 0
})

/**
 * t-vs5krz: the Apply in rowid ranges. It was one SELECT and one UPDATE over
 * the whole part table: one 4.0 s block of the event loop on the owner-size
 * store copy. Now each range is one IMMEDIATE transaction: it reads its
 * candidates with their sizes, then rewrites exactly those rows, with a loop
 * turn between the read and the rewrite and after each range.
 *
 * A row above `HUGE_BYTES` is read with the dry run's rule (no parse), and its
 * UPDATE checks the full rule itself: it is rewritten only when the single
 * statement would have rewritten it, and it counts whole as images, as in the
 * dry run. Its rewrite still loads and parses it in one call: 268-296 ms for
 * the 118 MB row on the owner-size store copy. One row's rewrite cannot be split.
 */
const applyRanged = Effect.fnUntraced(function* (
  cutoff: number,
  input: { readonly sliceRows?: number; readonly sliceBytes?: number; readonly hugeBytes?: number },
) {
  const huge = input.hugeBytes ?? StorageNestsMeasure.HUGE_BYTES
  const { db } = yield* Database.Service
  const sums: Measured = { n: 0, out_bytes: 0, img_bytes: 0 }
  const compacted = Date.now()
  yield* StorageNestsMeasure.eachRange({
    table: "part",
    top: yield* partTop(),
    read: (lo, hi) =>
      db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const rows = yield* tx.all<{ r: number; len: number; o: number | null; i: number | null }>(
                sql`SELECT ${sql.identifier("part")}.rowid AS r, octet_length(${sql.identifier("part")}.data) AS len,
                  CASE WHEN octet_length(${sql.identifier("part")}.data) > ${huge} THEN NULL
                    ELSE length(coalesce(json_extract(${sql.identifier("part")}.data, '$.state.output'), '')) END AS o,
                  CASE WHEN octet_length(${sql.identifier("part")}.data) > ${huge} THEN NULL
                    ELSE length(coalesce(json_extract(${sql.identifier("part")}.data, '$.state.attachments'), '')) END AS i
                  FROM ${sql.identifier("part")} WHERE ${candidates(cutoff, lo, hi, huge)}`,
              )
              if (rows.length === 0) return
              yield* StorageNestsMeasure.turn
              const rewrite = (where: SQL) =>
                tx.run(
                  sql`UPDATE ${sql.identifier("part")} SET data = json_set(
                    json_remove(data, '$.state.attachments'),
                    '$.state.output', ${MARKER},
                    '$.state.time.compacted', ${compacted}
                  ) WHERE ${where}`,
                )
              const small = rows.filter((row) => row.o !== null)
              if (small.length > 0) {
                yield* rewrite(
                  sql`rowid IN (${sql.join(
                    small.map((row) => sql`${row.r}`),
                    sql`, `,
                  )})`,
                )
                for (const row of small) {
                  sums.n++
                  sums.out_bytes += row.o ?? 0
                  sums.img_bytes += row.i ?? 0
                }
              }
              for (const row of rows.filter((row) => row.o === null)) {
                yield* rewrite(candidates(cutoff, row.r - 1, row.r))
                const changed = yield* tx.get<{ n: number }>(sql`SELECT changes() AS n`)
                if (!changed?.n) continue
                sums.n++
                sums.out_bytes += MARKER.length
                sums.img_bytes += row.len
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie),
    ...(input.sliceRows !== undefined ? { sliceRows: input.sliceRows } : {}),
    ...(input.sliceBytes !== undefined ? { sliceBytes: input.sliceBytes } : {}),
  })
  return sums
})

/**
 * t-vs5krz: the dry run's count in rowid ranges (`StorageNestsMeasure.eachRange`).
 * The one statement above held the engine's event loop 1.6-2.5 s on the
 * owner-size store copy (bun:sqlite is synchronous); the Nests Storage card runs
 * a dry run for every Keep choice. The tail is read once (34 ms on that copy);
 * each range returns only its admitted parts, and the tail check is done here.
 *
 * A part row above `HUGE_BYTES` is not parsed, the same rule as the measure
 * (`StorageNestsMeasure`): it is a candidate when it is old and its JSON starts
 * with `{"type":"tool"`, and all its bytes count as images. The 118 MB row on
 * the owner's store took 175-250 ms to parse alone. The status, tool name and
 * output of such a row are not checked, so the dry run can count a huge row the
 * Apply keeps. On the owner-size copy: the same 22,778 parts, and 429 bytes
 * more than the parsed sums (of 378.6 MB).
 */
const measureRanged = Effect.fnUntraced(function* (
  cutoff: number,
  input: { readonly sliceRows?: number; readonly sliceBytes?: number; readonly hugeBytes?: number },
) {
  const huge = input.hugeBytes ?? StorageNestsMeasure.HUGE_BYTES
  const { db } = yield* Database.Service
  const tail = new Set(
    (yield* db.all<{ id: string }>(TAIL).pipe(Effect.orDie)).map((row) => row.id),
  )
  const sums: Measured = { n: 0, out_bytes: 0, img_bytes: 0 }
  yield* StorageNestsMeasure.eachRange({
    table: "part",
    top: yield* partTop(),
    read: (lo, hi) =>
      db
        .all<{ m: string; o: number; i: number }>(
          sql`SELECT ${sql.identifier("part")}.message_id AS m,
            CASE WHEN octet_length(${sql.identifier("part")}.data) > ${huge} THEN ${MARKER.length}
              ELSE length(coalesce(json_extract(${sql.identifier("part")}.data, '$.state.output'), '')) END AS o,
            CASE WHEN octet_length(${sql.identifier("part")}.data) > ${huge} THEN octet_length(${sql.identifier("part")}.data)
              ELSE length(coalesce(json_extract(${sql.identifier("part")}.data, '$.state.attachments'), '')) END AS i
            FROM ${sql.identifier("part")}
            WHERE ${sql.identifier("part")}.rowid > ${lo} AND ${sql.identifier("part")}.rowid <= ${hi}
              AND ${admittedOrHuge(cutoff, huge)}`,
        )
        .pipe(
          Effect.orDie,
          Effect.map((rows) => {
            for (const row of rows) {
              if (tail.has(row.m)) continue
              sums.n++
              sums.out_bytes += row.o
              sums.img_bytes += row.i
            }
          }),
        ),
    ...(input.sliceRows !== undefined ? { sliceRows: input.sliceRows } : {}),
    ...(input.sliceBytes !== undefined ? { sliceBytes: input.sliceBytes } : {}),
  })
  return sums
})

// t-w2r1kf: the whole-table statements of `stats` and of the prune's row
// counts, as plain SQL text, so the Worker (`read-runner.ts`) and the inline
// fallback run the very same statements.
const COUNTS_SQL = `SELECT
        (SELECT count(*) FROM "event") AS events,
        (SELECT count(*) FROM "message") AS messages,
        (SELECT count(*) FROM "part") AS parts`

const STATS_SQL = {
  page: `SELECT (SELECT * FROM pragma_page_count()) AS page_count, (SELECT * FROM pragma_page_size()) AS page_size`,
  journal: `SELECT sum(length(data)) AS b FROM "event"`,
  messages: `SELECT sum(length(data)) AS b FROM "message"`,
  // One pass over `part` for the whole split: the table is gigabytes, and three
  // passes would be three full scans for numbers that come from the same rows.
  parts: `SELECT
        sum(length(data)) AS total,
        sum(CASE WHEN json_extract(data, '$.type') = 'tool'
          THEN length(coalesce(json_extract(data, '$.state.output'), '')) ELSE 0 END) AS tool_output,
        sum(CASE
          WHEN json_extract(data, '$.type') = 'tool'
            THEN length(coalesce(json_extract(data, '$.state.attachments'), ''))
          WHEN json_extract(data, '$.type') = 'file' THEN length(data)
          ELSE 0 END) AS images
        FROM "part"`,
  counts: COUNTS_SQL,
  sessions: `SELECT count(*) AS n FROM "session"`,
} as const

/** The file of the engine's store connection; empty for an in-memory store. */
const storeFile = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const rows = yield* db.all<{ name: string; file: string }>(sql`PRAGMA database_list`).pipe(Effect.orDie)
  return rows.find((row) => row.name === "main")?.file || undefined
})

/** Run read-only statements, one row each: on the storage Worker when it can,
 *  else on the engine's connection as before (t-w2r1kf). */
const readRows = Effect.fnUntraced(function* (statements: ReadonlyArray<string>) {
  const rows = yield* StorageRead.read(yield* storeFile(), statements)
  if (rows !== undefined) return rows
  StorageRead.noteInline()
  const { db } = yield* Database.Service
  const inline: unknown[] = []
  for (const statement of statements) inline.push(yield* db.get(sql.raw(statement)).pipe(Effect.orDie))
  return inline
})

const rowCounts = Effect.fnUntraced(function* () {
  const [row] = (yield* readRows([COUNTS_SQL])) as [{ events: number; messages: number; parts: number } | undefined]
  return { events: row?.events ?? 0, messages: row?.messages ?? 0, parts: row?.parts ?? 0 }
})

export const stats = Effect.fn("StorageRetention.stats")(function* () {
  const started = Date.now()
  const [page, journal, messages, parts, counted, sessions] = (yield* readRows([
    STATS_SQL.page,
    STATS_SQL.journal,
    STATS_SQL.messages,
    STATS_SQL.parts,
    STATS_SQL.counts,
    STATS_SQL.sessions,
  ])) as [
    { page_count: number; page_size: number } | undefined,
    { b: number | null } | undefined,
    { b: number | null } | undefined,
    { total: number | null; tool_output: number | null; images: number | null } | undefined,
    { events: number; messages: number; parts: number } | undefined,
    { n: number } | undefined,
  ]
  const counts = { events: counted?.events ?? 0, messages: counted?.messages ?? 0, parts: counted?.parts ?? 0 }
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
 * t-vs5krz: it is batched by rowid (`applyRanged`): one short transaction per
 * range, so the write lock and the event loop are held for one range at a time,
 * not for the whole table.
 *
 * VACUUM is NOT run: it rewrites the entire file (15.6 GB on the owner's box)
 * into a new one, needs that much free space again, and locks the store while it
 * does. The freed pages are reused by the next writes instead; the file total in
 * `stats` is the number that will not move until someone vacuums deliberately.
 */
export const prune = Effect.fn("StorageRetention.prune")(function* (input: {
  olderThanDays: number
  dryRun: boolean
  /** Tests only: smaller ranges and a smaller huge-row bound. */
  sliceRows?: number
  sliceBytes?: number
  hugeBytes?: number
}) {
  const olderThanDays = Math.max(MIN_WINDOW_DAYS, Math.floor(input.olderThanDays))
  const cutoff = Date.now() - olderThanDays * MS_IN_DAY
  const measured = input.dryRun ? yield* measureRanged(cutoff, input) : yield* applyRanged(cutoff, input)
  const parts = measured.n
  const toolOutputBytes = Math.max(0, measured.out_bytes - parts * MARKER.length)
  const imageBytes = measured.img_bytes
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
