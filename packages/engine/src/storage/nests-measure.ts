export * as StorageNestsMeasure from "./nests-measure"

import { Effect } from "effect"
import { sql, type SQL } from "drizzle-orm"
import { Database } from "@origami/core/database/database"

/**
 * t-vbivj4: `nest_storage` measured in slices.
 *
 * The first measure summed `length(data)` over every row of `event`, `message`
 * and `part` in three statements. On the owner's store (15 GB, 11 GB of
 * journal) that ran 44-52 s on a store copy, and bun:sqlite is synchronous, so
 * the engine's event loop stood still for all of it: no chat streamed, no ACP
 * call was answered, and the Storage card showed "Measuring..." all that time.
 *
 * Now:
 * - Sizes are `octet_length(data)`: the byte count, which SQLite reads from the
 *   record header without loading the value (the journal: 0.7 s, was 17.6 s).
 *   Only tool output still reads the JSON of a part.
 * - Each table is read in rowid ranges of at most SLICE_ROWS rows and
 *   SLICE_BYTES bytes (a range always takes its first row), and the fiber gives
 *   the event loop a turn between ranges.
 * - A part row above HUGE_BYTES is not parsed: its type comes from the first
 *   bytes of its JSON, and a tool or file part counts in full as tool output.
 *   One 118 MB row took 241-269 ms to parse alone. Parts are stored with
 *   `type` as their first key; a huge row that is not is still parsed.
 *
 * On the owner-size store copy: 5.5 s in all, longest event-loop stall 61 ms.
 *
 * t-vs5krz: short stalls were not enough. With ranges of up to 16 MB, one range
 * took most of every loop turn, and a small chat in the same engine waited
 * 0.6-3.4 s for its first word (soak on the store copy). Ranges are now at most
 * 1,024 rows and 4 MB (about 6 ms of JSON work on the owner's store), and after
 * WORK_MS of ranges the walk rests REST_MS on a timer, so other work gets
 * several loop turns. A range sized by measured time was tried first: inside the
 * engine that time also holds other fibers' work (scheduler yields, the
 * connection's semaphore), so under load the ranges shrank and the measure took
 * 80-118 s. The retention dry run walks the part table with the same
 * `eachRange`.
 *
 * `MeasureJob` keeps ONE measure per engine process. A second request joins
 * the one that runs (the card sends one on every mount), and `waitMs` makes a
 * request return the partial sums when the measure is not done by then.
 */

export const SLICE_ROWS = 1024
export const SLICE_BYTES = 4 * 1024 * 1024
export const HUGE_BYTES = 32 * 1024 * 1024
/** t-vs5krz: ranges back to back for at most this long, then a rest. */
export const WORK_MS = 8
export const REST_MS = 4

export type Sums = {
  journal: number
  partEvents: number
  body: [root: number, child: number]
  tool: [root: number, child: number]
  parts: [root: number, child: number]
}

export const emptySums = (): Sums => ({ journal: 0, partEvents: 0, body: [0, 0], tool: [0, 0], parts: [0, 0] })

export type Table = "event" | "message" | "part"
const TABLES: readonly Table[] = ["event", "message", "part"]

/** The rows after `lo`, at most `rows`, with their byte sizes. Header reads only. */
function sizes(table: Table, lo: number, rows: number): SQL {
  return sql`SELECT rowid AS r, octet_length(data) AS len FROM ${sql.identifier(table)}
    WHERE rowid > ${lo} ORDER BY rowid LIMIT ${rows}`
}

/** The last rowid of a range: rows while their bytes stay within `bytes`.
 *  The first row is always taken, however large, so a huge row is a range of
 *  its own. */
export function rangeEnd(next: readonly { r: number; len: number | null }[], bytes: number) {
  let run = 0
  let hi: number | undefined
  for (const row of next) {
    if (hi !== undefined && run + (row.len ?? 0) > bytes) break
    run += row.len ?? 0
    hi = row.r
  }
  return hi
}

/** One range of one table. CROSS JOIN keeps the range table as the outer
 *  loop, so the rowid range bounds the read. The per-row sizes are taken in a
 *  MATERIALIZED step: a GROUP BY straight over the join copies each `data`
 *  value into its sorter, which loses the header-only `octet_length` read
 *  (a 66 MB range of messages: 190-230 ms with it, 0 ms without). */
function slice(table: Table, lo: number, hi: number, huge: number): SQL {
  if (table === "event")
    return sql`SELECT 0 AS child, 0 AS n, sum(octet_length(data)) AS b, 0 AS tool,
        sum(CASE WHEN type LIKE 'message.part.updated.%' THEN 1 ELSE 0 END) AS pe
      FROM ${sql.identifier("event")} WHERE rowid > ${lo} AND rowid <= ${hi}`
  if (table === "message")
    return sql`WITH r AS MATERIALIZED (
        SELECT (s.parent_id IS NOT NULL) AS child, octet_length(m.data) AS b
        FROM ${sql.identifier("message")} m CROSS JOIN ${sql.identifier("session")} s ON s.id = m.session_id
        WHERE m.rowid > ${lo} AND m.rowid <= ${hi}
      ) SELECT child, 0 AS n, sum(b) AS b, 0 AS tool, 0 AS pe FROM r GROUP BY child`
  return sql`WITH r AS MATERIALIZED (
      SELECT (s.parent_id IS NOT NULL) AS child, octet_length(p.data) AS b,
        CASE
          WHEN octet_length(p.data) > ${huge}
            AND substr(p.data, 1, 14) IN ('{"type":"tool"', '{"type":"file"')
            THEN octet_length(p.data)
          WHEN json_extract(p.data, '$.type') = 'tool'
            THEN octet_length(coalesce(json_extract(p.data, '$.state.output'), ''))
              + octet_length(coalesce(json_extract(p.data, '$.state.attachments'), ''))
          WHEN json_extract(p.data, '$.type') = 'file' THEN octet_length(p.data)
          ELSE 0 END AS tool
      FROM ${sql.identifier("part")} p CROSS JOIN ${sql.identifier("session")} s ON s.id = p.session_id
      WHERE p.rowid > ${lo} AND p.rowid <= ${hi}
    ) SELECT child, count(*) AS n, sum(b) AS b, sum(tool) AS tool, 0 AS pe FROM r GROUP BY child`
}

type Row = { child: number; n: number; b: number | null; tool: number | null; pe: number | null }

function add(sums: Sums, table: Table, rows: readonly Row[]) {
  for (const row of rows) {
    if (table === "event") {
      sums.journal += row.b ?? 0
      sums.partEvents += row.pe ?? 0
      continue
    }
    const i = row.child ? 1 : 0
    sums.body[i] += row.b ?? 0
    if (table === "part") {
      sums.tool[i] += row.tool ?? 0
      sums.parts[i] += row.n
    }
  }
}

/** A macrotask turn: ACP calls, streaming chats and timers run here. */
export const turn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
/** A rest on a timer: the loop runs as many turns as other work needs. */
const rest = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, REST_MS)))

/**
 * Walk `table` up to rowid `top` in ranges of at most `sliceRows` rows and
 * `sliceBytes` bytes. `read(lo, hi)` reads the rows `lo < rowid <= hi`;
 * `after(hi)` runs after it. The event loop gets a turn after each range, and
 * a rest after WORK_MS of them.
 */
export function eachRange<E, R>(input: {
  readonly table: Table
  readonly top: number
  readonly read: (lo: number, hi: number) => Effect.Effect<void, E, R>
  readonly after?: (hi: number) => void
  readonly sliceRows?: number
  readonly sliceBytes?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = input.sliceRows ?? SLICE_ROWS
    const bytes = input.sliceBytes ?? SLICE_BYTES
    let lo = 0
    let since = performance.now()
    while (lo < input.top) {
      const hi = rangeEnd(
        yield* db.all<{ r: number; len: number | null }>(sizes(input.table, lo, rows)).pipe(Effect.orDie),
        bytes,
      )
      if (hi === undefined) break
      yield* input.read(lo, hi)
      lo = hi
      input.after?.(lo)
      if (performance.now() - since < WORK_MS) yield* turn
      else {
        yield* rest
        since = performance.now()
      }
    }
  })
}

/**
 * Walk the three tables in bounded rowid ranges. `onSlice(sums, progress)` runs
 * after each range; `progress` is the share of rowids read, 0..1.
 */
export const walk = Effect.fn("StorageNestsMeasure.walk")(function* (input: {
  readonly onSlice?: (sums: Sums, progress: number) => void
  /** Tests only: smaller ranges. */
  readonly sliceRows?: number
  readonly sliceBytes?: number
  readonly hugeBytes?: number
}) {
  const { db } = yield* Database.Service
  const huge = input.hugeBytes ?? HUGE_BYTES
  const sums = emptySums()
  const tops: Record<Table, number> = { event: 0, message: 0, part: 0 }
  for (const table of TABLES) {
    const row = yield* db
      .get<{ top: number | null }>(sql`SELECT max(rowid) AS top FROM ${sql.identifier(table)}`)
      .pipe(Effect.orDie)
    tops[table] = row?.top ?? 0
  }
  const total = tops.event + tops.message + tops.part
  let before = 0
  for (const table of TABLES) {
    yield* eachRange({
      table,
      top: tops[table],
      read: (lo, hi) =>
        db.all<Row>(slice(table, lo, hi, huge)).pipe(
          Effect.orDie,
          Effect.map((rows) => add(sums, table, rows)),
        ),
      after: (lo) => input.onSlice?.(sums, total === 0 ? 1 : (before + Math.min(lo, tops[table])) / total),
      ...(input.sliceRows !== undefined ? { sliceRows: input.sliceRows } : {}),
      ...(input.sliceBytes !== undefined ? { sliceBytes: input.sliceBytes } : {}),
    })
    before += tops[table]
  }
  return sums
})

/** One measure per engine process; later requests join it. */
export class MeasureJob<R> {
  private job: { partial: R | undefined; promise: Promise<R> } | undefined

  /** The running measure, or a new one from `start`. With `waitMs`, the answer
   *  is `partial(latest)` when the measure is not done by then. */
  read(
    start: (onPartial: (value: R) => void) => Promise<R>,
    waitMs: number | undefined,
    partial: (latest: R | undefined) => R,
  ) {
    const job = (this.job ??= this.begin(start))
    if (waitMs === undefined) return job.promise
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<R>((resolve) => {
      timer = setTimeout(() => resolve(partial(job.partial)), waitMs)
    })
    return Promise.race([job.promise, late]).finally(() => clearTimeout(timer))
  }

  private begin(start: (onPartial: (value: R) => void) => Promise<R>) {
    const job: { partial: R | undefined; promise: Promise<R> } = {
      partial: undefined,
      promise: Promise.resolve() as Promise<R>,
    }
    job.promise = start((value) => {
      job.partial = value
    }).finally(() => {
      if (this.job === job) this.job = undefined
    })
    // A request that took the partial answer is not waiting any more; a later
    // failure must not become an unhandled rejection in the engine.
    job.promise.catch(() => undefined)
    return job
  }
}
