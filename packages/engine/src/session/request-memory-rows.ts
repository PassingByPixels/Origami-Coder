import type { Database } from "@origami/core/database/database"
import { PartTable, SessionRequestMemoryTable } from "@origami/core/session/sql"
import { and, asc, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { SessionID } from "./schema"

/**
 * The rows of session request memory (t-w2qb1x): their kinds, the queue of rows
 * decided in this process and not yet written, and the table reads and writes.
 * It imports no engine store, so the stores that decide (tool-aging, degrade,
 * image-cap, window-fit) and the ToolSearch service can use it without a cycle.
 * `session/request-memory.ts` writes the queue and loads rows into the stores.
 */

/** What a row holds. `key` is "" for a store with one value per session. */
export type Kind =
  /** key = part id, data = the `Rewrite` sent instead of the stored fields. */
  | "aging.rewrite"
  /** key = part id, data = true: the part spent its one referenced-reprieve. */
  | "aging.reprieve"
  /** key = tool id, data = true: `tool_search` loaded it. */
  | "tool_search"
  /** key = knob label, data = true: the endpoint refused the knob. */
  | "degrade"
  /** key = "", data = the image cap the endpoint named. */
  | "image_cap"
  /** key = "", data = the window-fit calibration ratio. */
  | "window_fit"
  /** t-w2txb2: key = permission NUL pattern, data = {permission, pattern}: an
   *  "always allow" answer for this ROOT session (permission/index.ts). Not a
   *  request-byte input; kept here because it lives and dies with the session. */
  | "permission.always"
  /** t-wdyp7r: key = "", data = `SessionRestorePrefix.Mark`: the newest
   *  step-finish with a prefix that THIS store's engine wrote for the session,
   *  and the facts of its request the part does not carry. Local to the store
   *  (it never travels in a Nests journal and a fork does not copy it), so a
   *  step-finish another desk or the parent of a fork wrote is not a seed. */
  | "restore.seed"

export type Row = {
  readonly kind: Kind
  readonly key: string
  readonly data: unknown
}

const staged = new Map<string, Map<string, Row>>()

/** Queue rows for `sessionID`. A later row for the same kind and key replaces an
 *  earlier one that is still queued. */
export function stage(sessionID: string, rows: readonly Row[]): void {
  if (rows.length === 0) return
  const current = staged.get(sessionID) ?? new Map<string, Row>()
  for (const row of rows) current.set(row.kind + "\u0000" + row.key, row)
  staged.set(sessionID, current)
}

/** The queued rows, still queued. */
export function peek(sessionID: string): readonly Row[] {
  return [...(staged.get(sessionID)?.values() ?? [])]
}

/** The queued rows, removed from the queue. */
export function take(sessionID: string): readonly Row[] {
  const rows = staged.get(sessionID)
  if (!rows) return []
  staged.delete(sessionID)
  return [...rows.values()]
}

/** Test seam: a process that stops loses what it had not written. */
export function reset(): void {
  staged.clear()
}

type Db = Database.Interface["db"]

const table = SessionRequestMemoryTable

/** Rows per INSERT, well under SQLite's bound-parameter limit (4 per row). */
const CHUNK = 200

/** The rows the database holds for `sessionID` (of one kind, if given), in write order. */
export const load = (db: Db, sessionID: string, kind?: Kind) =>
  db
    .select({ kind: table.kind, key: table.key, data: table.data })
    .from(table)
    .where(
      kind === undefined
        ? eq(table.session_id, sessionID as SessionID)
        : and(eq(table.session_id, sessionID as SessionID), eq(table.kind, kind)),
    )
    .orderBy(asc(sql`rowid`))
    .all()
    .pipe(Effect.map((rows) => rows as Row[]))

/** Insert or replace rows, in one transaction. */
export const write = (db: Db, sessionID: string, rows: readonly Row[]) =>
  rows.length === 0
    ? Effect.void
    : db.transaction((tx) =>
        Effect.forEach(
          Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, index) =>
            rows.slice(index * CHUNK, (index + 1) * CHUNK),
          ),
          (chunk) =>
            tx
              .insert(table)
              .values(
                chunk.map((row) => ({
                  session_id: sessionID as SessionID,
                  kind: row.kind,
                  key: row.key,
                  data: row.data,
                })),
              )
              .onConflictDoUpdate({
                target: [table.session_id, table.kind, table.key],
                set: { data: sql`excluded.data` },
              })
              .run(),
          { discard: true },
        ),
      )

/**
 * t-wdyp7r: delete the aging rows of parts the session no longer has (a revert
 * deleted them). Such a decision can never be sent again, so the bytes do not
 * change; without this the rows only grow and every restore reads them all.
 * Rows of parts that still exist stay, before a compaction too: a revert past
 * the compaction sends those parts again, with the decisions taken for them.
 */
export const prune = (db: Db, sessionID: string) =>
  db
    .delete(table)
    .where(
      and(
        eq(table.session_id, sessionID as SessionID),
        sql`${table.kind} IN ('aging.rewrite', 'aging.reprieve')`,
        sql`${table.key} NOT IN (SELECT ${PartTable.id} FROM ${PartTable} WHERE ${PartTable.session_id} = ${sessionID})`,
      ),
    )
    .run()

/** Remove the rows of one kind (all kinds when omitted) for `sessionID`. */
export const remove = (db: Db, sessionID: string, kind?: Kind) =>
  db
    .delete(table)
    .where(
      kind === undefined
        ? eq(table.session_id, sessionID as SessionID)
        : and(eq(table.session_id, sessionID as SessionID), eq(table.kind, kind)),
    )
    .run()

export * as SessionRequestMemoryRows from "./request-memory-rows"
