export * as StorageNests from "./nests"

import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { Database } from "@origami/core/database/database"
import type { EventV2 } from "@origami/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Global } from "@origami/core/global"
import { ProjectTable } from "@origami/core/project/sql"
import { StorageJournal } from "./journal"
import { StorageNestsMeasure } from "./nests-measure"
import { StorageRetention } from "./retention"
import { artifactStore } from "@/artifact/instance"
import { ArtifactStore } from "@/artifact/store"
import type { PruneReport } from "@/artifact/types"

/**
 * Nests L4a (t-s9jgzh): the store side of cloud sessions between desks.
 *
 * The extension owns the sockets (remote/ in the VS Code package). The engine
 * gives it the data to send and applies the data it received:
 *
 * - `index` - this desk's rows of the nest index, from the session tables.
 * - `applyIndex` / `foreignIndex` - rows other desks sent, kept per desk.
 * - `exportChunk` / `importChunk` - one session's compact journal, in chunks with
 *   sequence ranges. The RECEIVER drives resume: it says which seq it has, and
 *   the sender sends from the next one.
 * - `storage` - bytes per retention class on this desk.
 * - `retention` - the per-class windows, and the existing prune applied with one.
 *
 * OWNERSHIP. `event_sequence.owner_id` is the writer of a session. A session
 * this desk wrote has no owner row until its first export, which CLAIMS it with
 * this desk's id. The claim has one more job: `StorageJournal.compact` skips any
 * session with an owner, and it must, because it renumbers sequences and a desk
 * that already holds seq N would then diverge. So the first export compacts,
 * claims, and from then on the numbering is fixed. An imported session is
 * replayed with `ownerID` = the source desk, so its owner row names that desk,
 * and a later chunk from a different writer is refused, not merged.
 *
 * INERT. The two tables below are created on the first call, and every call
 * comes through an ext method that refuses unless the host says Nests is on.
 * A desk that never turns Nests on therefore never gets the tables.
 */

export type NestState = "running" | "open" | "closed"

/** WIRE CONTRACT (shared with L4c and L5). Do not change without the lead. */
export type NestIndexRow = {
  readonly id: string
  readonly title: string
  /** Device id of the desk that holds this copy. */
  readonly desk: string
  readonly deskName: string
  readonly state: NestState
  /** Device id of the desk that writes this session. */
  readonly owner: string
  /** Epoch ms of the last message, or of the session row when it has none. */
  readonly lastAt: number
  readonly forkOf?: { readonly id: string; readonly desk: string; readonly at: number }
  /** Bytes of the session's journal: what an export of it transfers. */
  readonly size: number
  /** The session's last journal sequence; -1 when it has no journal. */
  readonly seq: number
}

export type Chunk = {
  readonly sessionId: string
  /** The session's writer at the time of export. */
  readonly owner: string
  /** First and last seq in `events`; with no events, `from = to + 1`. */
  readonly from: number
  readonly to: number
  /** The sender's last seq for this session when the chunk was read. */
  readonly last: number
  readonly done: boolean
  readonly events: readonly EventV2.SerializedEvent[]
  /** The session's project row, on the first chunk only (`from` = 0). The
   *  session row has a foreign key to it, and the receiving desk may not have
   *  the project. */
  readonly project?: typeof ProjectTable.$inferSelect
}

export type ExportResult = Chunk | { readonly refused: "not-found"; readonly sessionId: string }

export type ImportResult = {
  readonly sessionId: string
  /** The last seq this desk holds for the session after the call: the value the
   *  host sends back as `after` on the next export request. */
  readonly have: number
  readonly applied: number
  readonly done: boolean
  /** Why nothing (more) was applied. `gap`: the chunk starts after `have + 1`.
   *  `owner`: this desk holds the session under a different writer.
   *  `diverged`: an event at a seq this desk already has is not the same event. */
  readonly refused?: "gap" | "owner" | "diverged" | "bad-chunk"
}

export type ApplyResult = {
  readonly inserted: number
  readonly updated: number
  readonly unchanged: number
  /** A row with a lower seq than the one held: an older message that arrived late. */
  readonly stale: number
  /** Malformed rows, and rows that do not belong to `desk`. */
  readonly rejected: number
  /** With `replace`: rows of this desk that the full index no longer lists. */
  readonly removed: number
}

export const CLASSES = ["chats", "subagents", "toolOutput", "journal", "artifacts"] as const
export type RetentionClass = (typeof CLASSES)[number]
/** Days to keep, per class. `null` keeps everything. */
export type Windows = Readonly<Record<RetentionClass, number | null>>

export type StorageResult = {
  readonly deviceId: string
  /** Bytes per class. The five add up to what the store holds for chats; the
   *  file total below also counts free pages and every other table. */
  readonly classes: Readonly<Record<RetentionClass, number>>
  readonly fileBytes: number
  /** `message.part.updated` events per part row. About 1 on a compact journal;
   *  far above 1 on a journal that recorded every streamed delta. */
  readonly journalEventsPerPart: number
  readonly method: "length-sums"
  readonly measuredMs: number
  /** t-vbivj4: false on a partial answer (`nest_storage` with `waitMs`); the
   *  classes are then the sums so far. `progress` is the share read, 0..1. */
  readonly done: boolean
  readonly progress: number
}

/** t-vb87lt: the artifact prune, run with the artifacts window. The files of
 *  versions older than the window go; the newest version of every artifact
 *  keeps its files, and every version keeps its row (`ArtifactStore.pruneByWindow`). */
export type ArtifactPruneResult = {
  readonly dryRun: boolean
  readonly olderThanDays: number
  readonly blobs: number
  readonly bytes: number
}

export type RetentionResult = {
  readonly windows: Windows
  /** The prunes run, each with its class window. Absent when the call did not
   *  ask to apply, or no pruned class has a window. */
  readonly applied?: {
    readonly toolOutput?: StorageRetention.PruneResult
    readonly artifacts?: ArtifactPruneResult
  }
  /** Classes with a window set that no prune reads yet. */
  readonly unapplied: readonly RetentionClass[]
}

/** The classes a prune reads. */
const PRUNED: readonly RetentionClass[] = ["toolOutput", "artifacts"]

const DEFAULT_WINDOWS: Windows = {
  chats: null,
  subagents: null,
  toolOutput: null,
  journal: null,
  artifacts: null,
}

const INDEX = sql.identifier("nest_index")
const SETTING = sql.identifier("nest_setting")

const ensureTables = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  yield* db
    .run(
      sql`CREATE TABLE IF NOT EXISTS ${INDEX} (
        desk TEXT NOT NULL,
        id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        row TEXT NOT NULL,
        time_received INTEGER NOT NULL,
        PRIMARY KEY (desk, id))`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(sql`CREATE TABLE IF NOT EXISTS ${SETTING} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    .pipe(Effect.orDie)
})

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const STATES: readonly unknown[] = ["running", "open", "closed"]

/** A row as another desk sent it, or `undefined` when any field is wrong. The
 *  result is rebuilt field by field, so an extra key a peer sends is dropped
 *  rather than stored and pushed on to the webview. */
export function parseRow(value: unknown): NestIndexRow | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const row = value as Record<string, unknown>
  if (!isString(row.id) || typeof row.title !== "string" || !isString(row.desk) || !isString(row.owner)) return
  if (typeof row.deskName !== "string" || !STATES.includes(row.state)) return
  if (!isNumber(row.lastAt) || !isNumber(row.size) || !isNumber(row.seq)) return
  const forkOf = row.forkOf === undefined ? undefined : parseForkOf(row.forkOf)
  if (row.forkOf !== undefined && !forkOf) return
  return {
    id: row.id,
    title: row.title,
    desk: row.desk,
    deskName: row.deskName,
    state: row.state as NestState,
    owner: row.owner,
    lastAt: row.lastAt,
    ...(forkOf ? { forkOf } : {}),
    size: row.size,
    seq: row.seq,
  }
}

/**
 * A row that never carried a turn — the same test the desk's own History and
 * Labyrinth run index use to hide a session, mirrored from
 * `packages/vscode/src/dashboard/historyRows.ts`'s `isTurnless` (that file's
 * comment: "the chat-history dropdown and Labyrinth run index draw out" of
 * one projection, so this is the one rule, not a second one). Kept in sync by
 * `nests-isTurnless-mirror.test.ts`, which imports both and compares them.
 *
 * `title` is already on `NestIndexRow` on every build old and new, so no wire
 * change is needed for a row from an older desk to be judged by this rule.
 */
export function isTurnless(title: string): boolean {
  const s = (title ?? "").trim()
  return !s || /^New session\b/i.test(s)
}

function parseForkOf(value: unknown): NestIndexRow["forkOf"] {
  if (typeof value !== "object" || value === null) return undefined
  const fork = value as Record<string, unknown>
  if (!isString(fork.id) || !isString(fork.desk) || !isNumber(fork.at)) return undefined
  return { id: fork.id, desk: fork.desk, at: fork.at }
}

/** Journal bytes per session, keyed by the seq they were measured at. The sum
 *  reads the session's whole journal, and the index is asked for often; a
 *  session's journal changes only when its seq does. */
const sizes = new Map<string, { readonly seq: number; readonly size: number }>()

/**
 * This desk's rows. `running` and `open` come from the caller: run state and
 * open chats live in the engine instances and in the host's windows, not in
 * the store. A session another desk owns is never `running` here, whatever the
 * caller says: it cannot run on a desk that is not its writer.
 *
 * Root sessions only. A sub-agent's session is a separate journal; it travels
 * with its own export and is not a chat in the list.
 */
export const index = Effect.fn("StorageNests.index")(function* (input: {
  readonly deviceId: string
  readonly deskName: string
  readonly running: ReadonlySet<string>
  readonly open: ReadonlySet<string>
}) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .all<{
      id: string
      title: string
      time_updated: number
      time_archived: number | null
      metadata: string | null
      seq: number | null
      owner: string | null
      last_message: number | null
    }>(
      sql`SELECT s.id, s.title, s.time_updated, s.time_archived, s.metadata,
            q.seq AS seq, q.owner_id AS owner,
            (SELECT max(m.time_created) FROM ${sql.identifier("message")} m WHERE m.session_id = s.id) AS last_message
          FROM ${sql.identifier("session")} s
          LEFT JOIN ${sql.identifier("event_sequence")} q ON q.aggregate_id = s.id
          WHERE s.parent_id IS NULL
          ORDER BY s.id`,
    )
    .pipe(Effect.orDie)
  const out: NestIndexRow[] = []
  for (const row of rows) {
    const seq = row.seq ?? -1
    const owner = row.owner ?? input.deviceId
    const foreign = owner !== input.deviceId
    const state: NestState =
      !foreign && !row.time_archived && input.running.has(row.id)
        ? "running"
        : !row.time_archived && input.open.has(row.id)
          ? "open"
          : "closed"
    // A blank "New session - <ISO>" placeholder is never exported as a nest row
    // unless it is genuinely running right now (t-sj2qkr): the owning desk's
    // own History/Labyrinth never show it either, and a chat mid-turn must
    // still appear on a peer even with zero messages so far.
    if (isTurnless(row.title) && state !== "running") continue
    const forkOf = parseForkOf(parseMetadata(row.metadata)?.forkOf)
    out.push({
      id: row.id,
      title: row.title,
      desk: input.deviceId,
      deskName: input.deskName,
      state,
      owner,
      lastAt: row.last_message ?? row.time_updated,
      ...(forkOf ? { forkOf } : {}),
      size: yield* journalSize(row.id, seq),
      seq,
    })
  }
  return out
})

function parseMetadata(text: string | null): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const journalSize = Effect.fnUntraced(function* (sessionID: string, seq: number) {
  if (seq < 0) return 0
  const cached = sizes.get(sessionID)
  if (cached?.seq === seq) return cached.size
  const { db } = yield* Database.Service
  const row = yield* db
    .get<{
      b: number | null
    }>(sql`SELECT sum(length(data)) AS b FROM ${sql.identifier("event")} WHERE aggregate_id = ${sessionID}`)
    .pipe(Effect.orDie)
  const size = row?.b ?? 0
  sizes.set(sessionID, { seq, size })
  return size
})

/**
 * Merge rows `desk` sent. Idempotent by (desk, id, seq): the same rows applied
 * twice leave the table as the first apply did. A higher seq replaces the row;
 * the SAME seq also replaces it, because `state` changes without a journal
 * write (a chat is closed, a turn ends); a lower seq is a late, older message
 * and is dropped. `replace` means the rows are that desk's whole index, so a
 * row it no longer lists was deleted there and goes here too.
 */
export const applyIndex = Effect.fn("StorageNests.applyIndex")(function* (input: {
  readonly deviceId: string
  readonly desk: string
  readonly rows: readonly unknown[]
  readonly replace: boolean
}) {
  yield* ensureTables()
  const { db } = yield* Database.Service
  const totals = { inserted: 0, updated: 0, unchanged: 0, stale: 0, rejected: 0, removed: 0 }
  // This desk's own rows come from its session tables, never from a peer.
  if (input.desk === input.deviceId) return { ...totals, rejected: input.rows.length } satisfies ApplyResult
  const seen = new Set<string>()
  yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          for (const raw of input.rows) {
            const row = parseRow(raw)
            if (!row || row.desk !== input.desk) {
              totals.rejected++
              continue
            }
            seen.add(row.id)
            const text = JSON.stringify(row)
            const held = yield* db
              .get<{
                seq: number
                row: string
              }>(sql`SELECT seq, row FROM ${INDEX} WHERE desk = ${row.desk} AND id = ${row.id}`)
              .pipe(Effect.orDie)
            if (held && row.seq < held.seq) {
              totals.stale++
              continue
            }
            if (held && held.row === text) {
              totals.unchanged++
              continue
            }
            yield* db
              .run(
                sql`INSERT INTO ${INDEX} (desk, id, seq, row, time_received)
                    VALUES (${row.desk}, ${row.id}, ${row.seq}, ${text}, ${Date.now()})
                    ON CONFLICT (desk, id) DO UPDATE SET seq = excluded.seq, row = excluded.row,
                      time_received = excluded.time_received`,
              )
              .pipe(Effect.orDie)
            if (held) totals.updated++
            else totals.inserted++
          }
          if (!input.replace) return
          const listed = yield* db
            .all<{ id: string }>(sql`SELECT id FROM ${INDEX} WHERE desk = ${input.desk}`)
            .pipe(Effect.orDie)
          for (const { id } of listed) {
            if (seen.has(id)) continue
            yield* db.run(sql`DELETE FROM ${INDEX} WHERE desk = ${input.desk} AND id = ${id}`).pipe(Effect.orDie)
            totals.removed++
          }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
  return totals satisfies ApplyResult
})

/** Every row other desks sent, for the host's `origami/nestIndex` push. */
export const foreignIndex = Effect.fn("StorageNests.foreignIndex")(function* (input: { readonly deviceId: string }) {
  yield* ensureTables()
  const { db } = yield* Database.Service
  const rows = yield* db
    .all<{ row: string }>(sql`SELECT row FROM ${INDEX} WHERE desk <> ${input.deviceId} ORDER BY desk, id`)
    .pipe(Effect.orDie)
  return rows.flatMap((row) => {
    const parsed = parseRow(JSON.parse(row.row))
    if (!parsed) return []
    // Rows another (possibly older) desk stored before this rule existed are
    // hidden here on read, not migrated or deleted (t-sj2qkr).
    if (isTurnless(parsed.title) && parsed.state !== "running") return []
    return [parsed]
  })
})

/** L5 (t-sb9tlk). The writer of `sessionId` that other desks report, when one of
 *  them names a desk other than this one; the row with the highest seq wins. */
export const ownerFromIndex = Effect.fn("StorageNests.ownerFromIndex")(function* (input: {
  readonly deviceId: string
  readonly sessionId: string
}) {
  yield* ensureTables()
  const { db } = yield* Database.Service
  const rows = yield* db
    .all<{
      row: string
    }>(sql`SELECT row FROM ${INDEX} WHERE id = ${input.sessionId} AND desk <> ${input.deviceId} ORDER BY seq DESC`)
    .pipe(Effect.orDie)
  for (const { row } of rows) {
    const parsed = parseRow(JSON.parse(row))
    if (parsed && parsed.owner !== input.deviceId) return parsed.owner
  }
  return undefined
})

/** Default chunk budget: the relay's frame is 64 KiB, and the host seals and
 *  frames the JSON, so the payload stays well under it. */
export const DEFAULT_CHUNK_BYTES = 48 * 1024
/** Rows read per query while a chunk fills. */
const READ_BATCH = 256

/**
 * One chunk of a session's journal, from `after + 1`. Whole events only: an
 * event larger than `maxBytes` is sent alone in its own chunk, and the host
 * must split it across frames (a streamed tool output can be megabytes).
 *
 * The first export of a session this desk writes compacts it and claims it
 * (see the module comment); both are skipped once it has an owner.
 *
 * t-tc2193: the compaction, the claim, the batched read and the high-water raise
 * run in ONE `BEGIN IMMEDIATE` transaction. Another export, a Manager Compact or
 * another engine cannot renumber the journal between two of the reads, and the
 * mark a tail compaction keeps is the mark this chunk leaves.
 */
export const exportChunk = Effect.fn("StorageNests.exportChunk")(function* (input: {
  readonly deviceId: string
  readonly sessionId: string
  readonly after: number
  readonly maxBytes: number
}) {
  const { db } = yield* Database.Service
  return yield* db.transaction(() => exportLocked(input), { behavior: "immediate" }).pipe(Effect.orDie)
})

const exportLocked = Effect.fnUntraced(function* (input: {
  readonly deviceId: string
  readonly sessionId: string
  readonly after: number
  readonly maxBytes: number
}) {
  const { db } = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const owned = yield* ownerRow(input.sessionId)
  if (!owned) return { refused: "not-found", sessionId: input.sessionId } satisfies ExportResult
  if (owned.owner === null) {
    yield* StorageJournal.compact({ dryRun: false, sessionID: input.sessionId })
    yield* events.claim(input.sessionId, input.deviceId)
  } else if (owned.owner === input.deviceId) {
    // L5 (t-sb9tlk): the rows no desk can hold yet are compacted too, so a
    // session that was running at its first export does not keep every
    // streamed rewrite forever. Without a mark (claimed before L5) nothing is
    // known about what others hold, so nothing is touched.
    //
    // t-tc2193: the pass reads every payload past the mark, and it now does so
    // under the write lock. A pull asks for chunk after chunk with nothing
    // written in between, and after one pass the journal past ANY higher mark
    // is already compact. So a pass runs only when the session has changed
    // since the last one (a pass skipped for a running turn records nothing).
    const mark = yield* highWater(input.sessionId)
    const key = `tail-compacted:${input.sessionId}`
    if (mark !== undefined && owned.seq > mark && (yield* readSetting(key)) !== owned.seq) {
      const result = yield* StorageJournal.compact({ dryRun: false, sessionID: input.sessionId, above: mark })
      if (result.skipped.running === 0) yield* writeSetting(key, (yield* ownerRow(input.sessionId))?.seq ?? null)
    }
  }
  const current = yield* ownerRow(input.sessionId)
  const owner = current?.owner ?? input.deviceId
  const last = current?.seq ?? -1
  const out: EventV2.SerializedEvent[] = []
  let bytes = 0
  let cursor = input.after
  read: while (true) {
    const rows = yield* db
      .all<{ id: string; seq: number; type: string; data: string; n: number }>(
        sql`SELECT id, seq, type, data, length(data) AS n FROM ${sql.identifier("event")}
            WHERE aggregate_id = ${input.sessionId} AND seq > ${cursor}
            ORDER BY seq LIMIT ${READ_BATCH}`,
      )
      .pipe(Effect.orDie)
    if (rows.length === 0) break
    for (const row of rows) {
      if (out.length > 0 && bytes + row.n > input.maxBytes) break read
      out.push({
        id: row.id as EventV2.ID,
        aggregateID: input.sessionId,
        seq: row.seq,
        type: row.type,
        data: JSON.parse(row.data) as Record<string, unknown>,
      })
      bytes += row.n
      cursor = row.seq
    }
  }
  const from = input.after + 1
  const to = out.at(-1)?.seq ?? input.after
  const project =
    from === 0
      ? yield* db
          .select()
          .from(ProjectTable)
          .where(
            eq(
              ProjectTable.id,
              sql`(SELECT project_id FROM ${sql.identifier("session")} WHERE id = ${input.sessionId})`,
            ),
          )
          .get()
          .pipe(Effect.orDie)
      : undefined
  // Recorded BEFORE the chunk leaves: from here on a receiver may hold `to`.
  if (owner === input.deviceId && out.length > 0) yield* raiseHighWater(input.sessionId, to)
  return {
    sessionId: input.sessionId,
    owner,
    from,
    to,
    last,
    done: to >= last,
    events: out,
    ...(project ? { project } : {}),
  } satisfies Chunk
})

/**
 * L5 (t-sb9tlk). The HIGH-WATER MARK of a session this desk writes: the highest
 * seq another desk can hold, so the highest seq a tail compaction must keep.
 * Raised by every export of the owner, and set by a take-over to the seq the
 * session was taken at. Kept in `nest_setting`, per session.
 */
export const highWater = Effect.fnUntraced(function* (sessionID: string) {
  const value = yield* readSetting(`high-water:${sessionID}`)
  return isNumber(value) ? value : undefined
})

export const raiseHighWater = Effect.fnUntraced(function* (sessionID: string, seq: number) {
  const held = yield* highWater(sessionID)
  if (held === undefined || seq > held) yield* writeSetting(`high-water:${sessionID}`, seq)
})

/** One value of `nest_setting`, parsed; `undefined` when it is not set. */
export const readSetting = Effect.fnUntraced(function* (key: string) {
  yield* ensureTables()
  const { db } = yield* Database.Service
  const row = yield* db.get<{ value: string }>(sql`SELECT value FROM ${SETTING} WHERE key = ${key}`).pipe(Effect.orDie)
  return row ? (JSON.parse(row.value) as unknown) : undefined
})

export const writeSetting = Effect.fnUntraced(function* (key: string, value: unknown) {
  yield* ensureTables()
  const { db } = yield* Database.Service
  yield* db
    .run(
      sql`INSERT INTO ${SETTING} (key, value) VALUES (${key}, ${JSON.stringify(value)})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .pipe(Effect.orDie)
})

/**
 * L5 (t-sb9tlk), for the read-only guard after a restart. The device id (and
 * desk name) of the last call that passed the gate, kept in `nest_setting`, so
 * the guard knows which desk it is before the host calls a nest method again.
 *
 * t-t7l3pa: when the id differs from the stored one, this desk re-paired under a
 * new id. The sessions it claimed under the previous id are its own, so their
 * owner rows move to the new id. Only the previous LOCAL id moves; a session
 * another desk writes names that desk and is not touched. The move runs before
 * the new id is stored, so a second call finds nothing to move.
 */
export const rememberDevice = Effect.fn("StorageNests.rememberDevice")(function* (input: {
  readonly deviceId: string
  readonly deskName?: string
}) {
  // t-tjhmhw: one transaction. The write transaction refuses a local write when
  // the owner row and the stored id differ, so the rows and the id move together.
  const { db } = yield* Database.Service
  yield* ensureTables()
  yield* db.transaction(() => rememberDeviceBody(input), { behavior: "immediate" }).pipe(Effect.orDie)
})

const rememberDeviceBody = Effect.fnUntraced(function* (input: {
  readonly deviceId: string
  readonly deskName?: string
}) {
  const previous = yield* readSetting("device")
  if (isString(previous) && previous !== input.deviceId) {
    const { db } = yield* Database.Service
    const moved = yield* db
      .get<{ n: number }>(
        sql`SELECT count(*) AS n FROM ${sql.identifier("event_sequence")} WHERE owner_id = ${previous}`,
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`UPDATE ${sql.identifier("event_sequence")} SET owner_id = ${input.deviceId} WHERE owner_id = ${previous}`,
      )
      .pipe(Effect.orDie)
    yield* Effect.logInfo("nests: device id changed; owner rows re-attributed", {
      from: previous,
      to: input.deviceId,
      sessions: moved?.n ?? 0,
    })
  }
  yield* writeSetting("device", input.deviceId)
  if (input.deskName) yield* writeSetting("desk-name", input.deskName)
})

/** The stored device id, WITHOUT creating the tables: a desk that never turned
 *  Nests on has no `nest_setting`, and must not get one from the prompt path. */
export const storedDevice = Effect.fn("StorageNests.storedDevice")(function* () {
  const { db } = yield* Database.Service
  const table = yield* db
    .get<{ n: number }>(sql`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'nest_setting'`)
    .pipe(Effect.orDie)
  if (!table?.n) return undefined
  const value = yield* readSetting("device")
  return isString(value) ? value : undefined
})

export const ownerRow = Effect.fnUntraced(function* (sessionID: string) {
  const { db } = yield* Database.Service
  return yield* db
    .get<{
      seq: number
      owner: string | null
    }>(sql`SELECT seq, owner_id AS owner FROM ${sql.identifier("event_sequence")} WHERE aggregate_id = ${sessionID}`)
    .pipe(Effect.orDie)
})

/** A chunk as the host received it, or `undefined` when its shape is wrong. */
export function parseChunk(value: unknown): Chunk | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const chunk = value as Record<string, unknown>
  if (!isString(chunk.sessionId) || !isString(chunk.owner) || !Array.isArray(chunk.events)) return undefined
  if (!isNumber(chunk.from) || !isNumber(chunk.to) || !isNumber(chunk.last)) return undefined
  const events: EventV2.SerializedEvent[] = []
  for (const raw of chunk.events as unknown[]) {
    if (typeof raw !== "object" || raw === null) return undefined
    const event = raw as Record<string, unknown>
    if (!isString(event.id) || !isString(event.type) || !isNumber(event.seq)) return undefined
    if (event.aggregateID !== chunk.sessionId) return undefined
    if (typeof event.data !== "object" || event.data === null) return undefined
    // Contiguous, as `replayAll` demands: a hole inside one chunk is a broken
    // sender, not a resume point.
    if (events.length > 0 && event.seq !== events[0]!.seq + events.length) return undefined
    events.push({
      id: event.id as EventV2.ID,
      aggregateID: chunk.sessionId,
      seq: event.seq,
      type: event.type,
      data: event.data as Record<string, unknown>,
    })
  }
  const project =
    typeof chunk.project === "object" && chunk.project !== null
      ? (chunk.project as typeof ProjectTable.$inferSelect)
      : undefined
  if (project && (!isString(project.id) || !isString(project.worktree) || !Array.isArray(project.sandboxes)))
    return undefined
  return {
    sessionId: chunk.sessionId,
    owner: chunk.owner,
    from: chunk.from,
    to: chunk.to,
    last: chunk.last,
    done: chunk.done === true,
    events,
    ...(project ? { project } : {}),
  }
}

/**
 * Replay one chunk into this store. Events at a seq this desk already has are
 * re-checked by the replay (same id, type and payload, or `diverged`), so a
 * chunk sent twice is harmless. A chunk that starts past `have + 1` is refused
 * with `have`, which is where the host asks the sender to resume.
 *
 * `chunk` with no events asks only for `have`: the first message of a pull.
 */
export const importChunk = Effect.fn("StorageNests.importChunk")(function* (input: {
  readonly deviceId: string
  readonly chunk: unknown
}) {
  const chunk = parseChunk(input.chunk)
  const sessionId =
    typeof input.chunk === "object" && input.chunk !== null
      ? String((input.chunk as Record<string, unknown>).sessionId ?? "")
      : ""
  if (!chunk) return { sessionId, have: -1, applied: 0, done: false, refused: "bad-chunk" } satisfies ImportResult
  const { db } = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const held = yield* ownerRow(chunk.sessionId)
  const before = held?.seq ?? -1
  const result = (have: number, refused?: ImportResult["refused"]) =>
    ({
      sessionId: chunk.sessionId,
      have,
      applied: have - before,
      done: have >= chunk.last,
      ...(refused ? { refused } : {}),
    }) satisfies ImportResult
  // A session this desk holds has ONE writer. A local session with no owner
  // row yet was written here.
  if (held && (held.owner ?? input.deviceId) !== chunk.owner) return result(before, "owner")
  if (chunk.events.length === 0) return result(before)
  if (chunk.events[0]!.seq > before + 1) return result(before, "gap")
  if (chunk.project) yield* db.insert(ProjectTable).values(chunk.project).onConflictDoNothing().run().pipe(Effect.orDie)
  // `strictOwner` makes the replay itself refuse a different writer, as the sync
  // handler does; the check above only turns that into a result, not a defect.
  const exit = yield* events.replayAll([...chunk.events], { ownerID: chunk.owner, strictOwner: true }).pipe(Effect.exit)
  const after = (yield* ownerRow(chunk.sessionId))?.seq ?? -1
  return exit._tag === "Success" ? result(after) : result(after, "diverged")
})

/**
 * Bytes per class on this desk: `octet_length()` sums over the stored JSON,
 * over each large table in rowid ranges that yield to the event loop between
 * them (t-vbivj4, `StorageNestsMeasure`).
 * Tool output (with images and file parts) is counted once, as its own class,
 * and taken out of the chat and sub-agent figures, so the five add up.
 * `onPartial` gets the result so far after each range (`done: false`).
 */
export const storage = Effect.fn("StorageNests.storage")(function* (input: {
  readonly deviceId: string
  /** The artifact store's directory; the default is the one the engine uses. */
  readonly artifactsDir?: string
  readonly onPartial?: (partial: StorageResult) => void
  /** Tests only: smaller ranges (`StorageNestsMeasure.walk`). */
  readonly sliceRows?: number
  readonly sliceBytes?: number
  readonly hugeBytes?: number
}) {
  const { db } = yield* Database.Service
  const started = Date.now()
  const page = yield* db
    .get<{
      page_count: number
      page_size: number
    }>(sql`SELECT (SELECT * FROM pragma_page_count()) AS page_count, (SELECT * FROM pragma_page_size()) AS page_size`)
    .pipe(Effect.orDie)
  const artifacts = directoryBytes(input.artifactsDir ?? path.join(Global.Path.data, "artifacts"))
  const result = (sums: StorageNestsMeasure.Sums, progress: number, done: boolean): StorageResult => {
    const partCount = sums.parts[0] + sums.parts[1]
    return {
      deviceId: input.deviceId,
      classes: {
        chats: sums.body[0] - sums.tool[0],
        subagents: sums.body[1] - sums.tool[1],
        toolOutput: sums.tool[0] + sums.tool[1],
        journal: sums.journal,
        artifacts,
      },
      fileBytes: (page?.page_count ?? 0) * (page?.page_size ?? 0),
      journalEventsPerPart: partCount === 0 ? 0 : sums.partEvents / partCount,
      method: "length-sums",
      measuredMs: Date.now() - started,
      done,
      progress,
    }
  }
  const sums = yield* StorageNestsMeasure.walk({
    ...(input.sliceRows !== undefined ? { sliceRows: input.sliceRows } : {}),
    ...(input.sliceBytes !== undefined ? { sliceBytes: input.sliceBytes } : {}),
    ...(input.hugeBytes !== undefined ? { hugeBytes: input.hugeBytes } : {}),
    onSlice: (sums, progress) => input.onPartial?.(result(sums, progress, false)),
  })
  return result(sums, 1, true)
})

/** Sum of file sizes under `dir`; 0 when it does not exist. */
function directoryBytes(dir: string): number {
  let total = 0
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += directoryBytes(full)
    else if (entry.isFile()) {
      try {
        total += statSync(full).size
      } catch {
        // Removed between the listing and the stat: it holds nothing now.
      }
    }
  }
  return total
}

const readWindows = Effect.fnUntraced(function* () {
  yield* ensureTables()
  const { db } = yield* Database.Service
  const row = yield* db
    .get<{ value: string }>(sql`SELECT value FROM ${SETTING} WHERE key = 'retention'`)
    .pipe(Effect.orDie)
  const stored = row ? (JSON.parse(row.value) as Partial<Record<RetentionClass, number | null>>) : {}
  return Object.fromEntries(
    CLASSES.map((name) => [name, isNumber(stored[name]) ? stored[name] : DEFAULT_WINDOWS[name]]),
  ) as Windows
})

/**
 * Get, set and apply the per-class windows of this desk. They are a per-desk
 * setting and are not synced. `set` merges: a class it does not name keeps its
 * window; `null` keeps everything. A window is raised to the prune's own floor
 * (`StorageRetention.MIN_WINDOW_DAYS`) before it is stored, so the value read
 * back is the value a prune uses.
 *
 * `apply` runs the tool-output prune and the artifact prune (t-vb87lt), each
 * with its class window, dry unless `dryRun` is exactly false. A dry run may
 * name `windows` to use in place of the stored ones (the card asks what a
 * choice frees before it is applied); they are not stored. The other classes
 * have no prune yet: dropping chat bodies needs the mother-base check (L4b), so
 * they are listed as `unapplied` instead of being ignored in silence.
 */
export const retention = Effect.fn("StorageNests.retention")(function* (input: {
  readonly set?: Partial<Record<RetentionClass, number | null>>
  readonly apply?: { readonly dryRun: boolean; readonly windows?: Partial<Record<RetentionClass, number | null>> }
  /** The artifact store's directory; the default is the one the engine uses. */
  readonly artifactsDir?: string
}) {
  const { db } = yield* Database.Service
  let windows = yield* readWindows()
  if (input.set) {
    const next = merged(windows, input.set)
    yield* db
      .run(
        sql`INSERT INTO ${SETTING} (key, value) VALUES ('retention', ${JSON.stringify(next)})
            ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .pipe(Effect.orDie)
    windows = next as Windows
  }
  const dryRun = input.apply?.dryRun ?? true
  const use = dryRun && input.apply?.windows ? merged(windows, input.apply.windows) : windows
  const unapplied = CLASSES.filter((name) => !PRUNED.includes(name) && use[name] !== null)
  if (!input.apply || (use.toolOutput === null && use.artifacts === null))
    return { windows, unapplied } satisfies RetentionResult
  const toolOutput =
    use.toolOutput === null ? undefined : yield* StorageRetention.prune({ olderThanDays: use.toolOutput, dryRun })
  const artifacts =
    use.artifacts === null ? undefined : yield* pruneArtifacts(input.artifactsDir, use.artifacts, dryRun)
  return {
    windows,
    applied: { ...(toolOutput ? { toolOutput } : {}), ...(artifacts ? { artifacts } : {}) },
    unapplied,
  } satisfies RetentionResult
})

/** `windows` with the classes `set` names replaced: a number is raised to the
 *  prune's floor, anything else keeps everything. */
function merged(windows: Windows, set: Partial<Record<RetentionClass, number | null>>): Windows {
  const next: Record<string, number | null> = { ...windows }
  for (const name of CLASSES) {
    if (!(name in set)) continue
    const value = set[name]
    next[name] = isNumber(value) ? Math.max(StorageRetention.MIN_WINDOW_DAYS, Math.floor(value)) : null
  }
  return next as Windows
}

/** The artifact prune. A desk with no artifact store has nothing to prune and
 *  does not get a store by asking. */
const pruneArtifacts = (dir: string | undefined, days: number, dryRun: boolean) =>
  Effect.promise(async (): Promise<ArtifactPruneResult> => {
    const root = dir ?? path.join(Global.Path.data, "artifacts")
    const done = (report: PruneReport) => ({
      dryRun,
      olderThanDays: days,
      blobs: report.removedBlobs,
      bytes: report.removedBytes,
    })
    if (!existsSync(path.join(root, "artifacts.db"))) return done({ removedBlobs: 0, removedBytes: 0 })
    // The engine's own store goes through the one handle of this process.
    if (dir === undefined) return done((await artifactStore()).pruneByWindow(days, { dryRun }))
    const store = await ArtifactStore.open(dir)
    try {
      return done(store.pruneByWindow(days, { dryRun }))
    } finally {
      store.close()
    }
  })

/** The writer of a session when it is not `deviceId`; `undefined` when this desk
 *  may write it. The prompt path asks this once Nests has been used here. */
export const foreignOwner = Effect.fn("StorageNests.foreignOwner")(function* (input: {
  readonly deviceId: string
  readonly sessionId: string
}) {
  const row = yield* ownerRow(input.sessionId)
  return row?.owner && row.owner !== input.deviceId ? row.owner : undefined
})
