export * as StorageNestsHandover from "./nests-handover"

import { Cause, Deferred, Effect, Fiber } from "effect"
import { asc, eq, sql } from "drizzle-orm"
import { Database } from "@origami/core/database/database"
import { EventV2 } from "@origami/core/event"
import { TodoTable } from "@origami/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionRequestMemoryRows } from "@/session/request-memory-rows"
import { StorageNests } from "./nests"
import { ElasticActivity } from "@/elastic/activity"

/**
 * Nests L5 (t-sb9tlk): a chat changes desks. Design: cloud_sessions_design
 * section 5 and the owner decisions; mock round 7 rule 5.
 *
 * - `continueHere` - "Continue here" on a desk that holds a copy. The owner is
 *   idle or offline: this desk takes the session over (`owner_id` = this desk).
 *   The owner is mid-turn: this desk makes a FORK and the original stays with
 *   its owner.
 * - `release` - on the old owner, when the hand-over frame arrives: `owner_id`
 *   becomes the new desk. The ACP layer then stops any running turn.
 * - `reconcile` - on a returning owner that finds local events past the seq the
 *   nest saw. Those events are saved as a fork; the original is rebuilt from its
 *   first `remoteSeq + 1` events and then pulled from the nest again.
 *
 * A FORK is a copy of the session's journal under new ids (session, messages,
 * parts, events), replayed through the projectors, so the fork's tables come
 * from its own journal exactly as an import does. It has no owner row, so this
 * desk writes it, and its first export compacts and claims it (L4a).
 */

export type ForkOf = NonNullable<StorageNests.NestIndexRow["forkOf"]>

export type ContinueResult =
  | {
      readonly result: "taken"
      readonly sessionId: string
      /** The seq the session was taken at: the old owner reconciles against it. */
      readonly seq: number
    }
  | {
      readonly result: "forked"
      readonly sessionId: string
      readonly forkOf: ForkOf
      readonly seq: number
    }
  | { readonly refused: "not-found"; readonly sessionId: string }

export type ReleaseResult =
  | {
      readonly sessionId: string
      readonly owner: string
      readonly seq: number
      /** The session's directory, for the abort the ACP layer runs next. */
      readonly directory: string | undefined
    }
  | { readonly refused: "not-found" | "unknown-owner"; readonly sessionId: string }

export type ReconcileResult =
  | { readonly result: "clean"; readonly sessionId: string; readonly have: number }
  | {
      readonly result: "forked"
      readonly sessionId: string
      /** What this desk now holds of the original: pull from here. */
      readonly have: number
      readonly owner: string
      readonly fork: { readonly sessionId: string; readonly title: string; readonly forkOf: ForkOf }
    }
  | { readonly refused: "not-found" | "unknown-owner"; readonly sessionId: string }

type Row = { id: string; seq: number; type: string; data: string }

const journalRows = Effect.fnUntraced(function* (sessionID: string, upTo?: number) {
  const { db } = yield* Database.Service
  return yield* db
    .all<Row>(
      sql`SELECT id, seq, type, data FROM ${sql.identifier("event")}
          WHERE aggregate_id = ${sessionID} ${upTo === undefined ? sql`` : sql`AND seq <= ${upTo}`}
          ORDER BY seq`,
    )
    .pipe(Effect.orDie)
})

const sessionRow = Effect.fnUntraced(function* (sessionID: string) {
  const { db } = yield* Database.Service
  return yield* db
    .get<{
      title: string
      directory: string
    }>(sql`SELECT title, directory FROM ${sql.identifier("session")} WHERE id = ${sessionID}`)
    .pipe(Effect.orDie)
})

/** Same rule as `Session.fork`'s title (session/session.ts `getForkedTitle`),
 *  copied rather than imported: the storage layer does not load the session
 *  service module. */
export function forkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) return `${match[1]} (fork #${parseInt(match[2]!, 10) + 1})`
  return `${title} (fork #1)`
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Every string equal to a key of `ids` becomes its value, at any depth. Whole
 *  strings only: an id quoted inside a text is left as the text wrote it. */
function remap(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value
  if (Array.isArray(value)) return value.map((item) => remap(item, ids))
  const object = record(value)
  if (!object) return value
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, remap(item, ids)]))
}

/**
 * The message and part ids this journal DEFINES, each mapped to a new one. Ids
 * that only appear as references to other sessions (a sub-agent's session id on
 * a task part, for example) are not in the map and so keep pointing where they
 * pointed. New ids are handed out in the sorted order of the old ones, so the
 * fork lists its messages and parts in the same order as the original.
 */
function idMap(sessionID: string, fork: string, events: readonly { type: string; data: Record<string, unknown> }[]) {
  const messages = new Set<string>()
  const parts = new Set<string>()
  const add = (set: Set<string>, value: unknown) => {
    if (typeof value === "string" && value.length > 0) set.add(value)
  }
  for (const event of events) {
    const info = record(event.data.info)
    const part = record(event.data.part)
    if (event.type.startsWith("message.updated.")) add(messages, info?.id)
    add(messages, part?.messageID)
    add(parts, part?.id)
    add(messages, event.data.messageID)
    add(parts, event.data.partID)
  }
  const ids = new Map<string, string>([[sessionID, fork]])
  for (const id of [...messages].sort()) ids.set(id, MessageID.ascending())
  for (const id of [...parts].sort()) ids.set(id, PartID.ascending())
  return ids
}

/**
 * Copy `sessionId`'s journal (all of it) into a new session and replay it. The
 * session events of the copy carry `title` and `metadata.forkOf`, so the fork's
 * row, and its nest index row, name the parent. The todo list (a table, not an
 * event) is copied too, as `Session.fork` does.
 */
export const fork = Effect.fn("StorageNestsHandover.fork")(function* (input: {
  readonly sessionId: string
  readonly title: string
  readonly forkOf: ForkOf
}) {
  const { db } = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const rows = yield* journalRows(input.sessionId)
  const parsed = rows.map((row) => ({ type: row.type, data: JSON.parse(row.data) as Record<string, unknown> }))
  const id = SessionID.descending()
  const ids = idMap(input.sessionId, id, parsed)
  const copy: EventV2.SerializedEvent[] = parsed.map((event, seq) => {
    const data = remap(event.data, ids) as Record<string, unknown>
    const info = record(data.info)
    if (info && (event.type.startsWith("session.created.") || event.type.startsWith("session.updated."))) {
      data.info = { ...info, title: input.title, metadata: { ...record(info.metadata), forkOf: input.forkOf } }
    }
    return { id: EventV2.ID.create(), aggregateID: id, seq, type: event.type, data }
  })
  yield* events.replayAll(copy)
  const todos = yield* db
    .select()
    .from(TodoTable)
    .where(eq(TodoTable.session_id, input.sessionId as SessionID))
    .orderBy(asc(TodoTable.position))
    .all()
    .pipe(Effect.orDie)
  if (todos.length > 0)
    yield* db
      .insert(TodoTable)
      .values(
        todos.map((todo) => ({
          session_id: id,
          content: todo.content,
          status: todo.status,
          priority: todo.priority,
          position: todo.position,
          depth: todo.depth,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  return { sessionId: id as string, seq: copy.length - 1 }
})

/**
 * "Continue here". Owner running there: a fork here, the original untouched.
 * Otherwise this desk becomes the writer, and the seq it holds becomes the
 * session's high-water mark: another desk may hold every row up to it, so a
 * tail compaction here keeps them.
 *
 * A session this desk already writes (or never exported: no owner row) is
 * `taken` with nothing written.
 */
export const continueHere = Effect.fn("StorageNestsHandover.continueHere")(function* (input: {
  readonly deviceId: string
  readonly sessionId: string
  readonly ownerRunning: boolean
  readonly now?: number
}) {
  const events = yield* EventV2Bridge.Service
  const held = yield* StorageNests.ownerRow(input.sessionId)
  const row = yield* sessionRow(input.sessionId)
  if (!held || !row) return { refused: "not-found", sessionId: input.sessionId } satisfies ContinueResult
  const owner = held.owner ?? input.deviceId
  if (owner === input.deviceId)
    return { result: "taken", sessionId: input.sessionId, seq: held.seq } satisfies ContinueResult
  // t-tc2b6c: a turn on this store (any engine) counts as well as the host's word.
  if (input.ownerRunning || (yield* runningHere(input.sessionId))) {
    const forkOf = { id: input.sessionId, desk: owner, at: input.now ?? Date.now() }
    const made = yield* fork({ sessionId: input.sessionId, title: forkedTitle(row.title), forkOf })
    return { result: "forked", sessionId: made.sessionId, forkOf, seq: made.seq } satisfies ContinueResult
  }
  yield* events.claim(input.sessionId, input.deviceId)
  yield* StorageNests.raiseHighWater(input.sessionId, held.seq)
  return { result: "taken", sessionId: input.sessionId, seq: held.seq } satisfies ContinueResult
})

/** The desk a session is handed to: the caller's word, else the owner row when
 *  it already names another desk, else what the other desks' index rows say. */
const newOwner = Effect.fnUntraced(function* (input: {
  readonly deviceId: string
  readonly sessionId: string
  readonly owner?: string
  readonly held: string | null
}) {
  if (input.owner) return input.owner
  if (input.held && input.held !== input.deviceId) return input.held
  return yield* StorageNests.ownerFromIndex({ deviceId: input.deviceId, sessionId: input.sessionId })
})

/**
 * The checks of a release, with no write: the desk the chat goes to and the
 * directory its turn runs in, or the refusal. t-tjhmhw: the ACP layer runs this
 * FIRST, stops the running turn (so it writes its closing state while this desk
 * still owns the chat), and only then calls `release`.
 */
export const releasePlan = Effect.fn("StorageNestsHandover.releasePlan")(function* (input: {
  readonly deviceId: string
  readonly sessionId: string
  readonly owner?: string
}) {
  const held = yield* StorageNests.ownerRow(input.sessionId)
  if (!held) return { refused: "not-found", sessionId: input.sessionId } satisfies ReleaseResult
  const owner = yield* newOwner({ ...input, held: held.owner })
  if (!owner || owner === input.deviceId)
    return { refused: "unknown-owner", sessionId: input.sessionId } satisfies ReleaseResult
  const row = yield* sessionRow(input.sessionId)
  return { sessionId: input.sessionId, owner, seq: held.seq, directory: row?.directory } satisfies ReleaseResult
})

/**
 * The old owner's half of a hand-over: `owner_id` becomes the new desk. From
 * this write on, every local write into the session is refused (the ACP guard,
 * and t-tjhmhw the write transaction itself). The ACP layer stops the running
 * turn BEFORE this (t-tjhmhw), so the stopped turn's closing state is kept.
 */
export const release = Effect.fn("StorageNestsHandover.release")(function* (input: {
  readonly deviceId: string
  readonly sessionId: string
  readonly owner?: string
}) {
  const plan = yield* releasePlan(input)
  if ("refused" in plan) return plan
  const events = yield* EventV2Bridge.Service
  yield* events.claim(input.sessionId, plan.owner)
  return plan
})

/** "14:02": the fork name's time, in this desk's local time. */
const clock = (at: number) => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/**
 * A returning owner's one check. Nothing past `remoteSeq` here: `clean`.
 * Otherwise the WHOLE local journal (the shared part and what only this desk
 * wrote) is saved as a fork named "<title> (<desk>, <time>)", and the original
 * is rebuilt from its events up to `remoteSeq`, owned by the desk that wrote on
 * past it, so the host can pull the rest from the nest (`nest_import` from
 * `have + 1`). Nothing is lost: every local event is in the fork.
 */
export const reconcile = Effect.fn("StorageNestsHandover.reconcile")(function* (input: {
  readonly deviceId: string
  readonly sessionId: string
  readonly remoteSeq: number
  readonly owner?: string
  readonly deskName?: string
  readonly now?: number
}) {
  const { db } = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const held = yield* StorageNests.ownerRow(input.sessionId)
  const row = yield* sessionRow(input.sessionId)
  if (!held || !row) return { refused: "not-found", sessionId: input.sessionId } satisfies ReconcileResult
  if (held.seq <= input.remoteSeq)
    return { result: "clean", sessionId: input.sessionId, have: held.seq } satisfies ReconcileResult
  const owner = yield* newOwner({ ...input, held: held.owner })
  if (!owner || owner === input.deviceId)
    return { refused: "unknown-owner", sessionId: input.sessionId } satisfies ReconcileResult
  const at = input.now ?? Date.now()
  const stored = yield* StorageNests.readSetting("desk-name")
  const desk = input.deskName || (typeof stored === "string" && stored) || input.deviceId
  const title = `${row.title} (${desk}, ${clock(at)})`
  const forkOf = { id: input.sessionId, desk: input.deviceId, at }
  const made = yield* fork({ sessionId: input.sessionId, title, forkOf })
  // The fork holds every event now; the original goes back to the shared prefix.
  const prefix = (yield* journalRows(input.sessionId, input.remoteSeq)).map(
    (event): EventV2.SerializedEvent => ({
      id: event.id as EventV2.ID,
      aggregateID: input.sessionId,
      seq: event.seq,
      type: event.type,
      data: JSON.parse(event.data) as Record<string, unknown>,
    }),
  )
  // t-wdyp7r: the cascade below also takes the session request memory (tool
  // aging, tool_search, refused knobs, "always allow" answers), which no
  // journal carries, while the engine that holds the chat keeps its copy. Read
  // here and put back once the replay has made the session row again. Rows of
  // parts that went to the fork are pruned on the next read (request-memory.ts).
  const memory = yield* SessionRequestMemoryRows.load(db, input.sessionId).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("nests reconcile: request memory not read", { "session.id": input.sessionId, cause }).pipe(
        Effect.as([] as SessionRequestMemoryRows.Row[]),
      ),
    ),
  )
  // The session row's delete cascades to its messages, parts, todos and the V2
  // tables; the replay below rebuilds them from the prefix.
  yield* db.run(sql`DELETE FROM ${sql.identifier("session")} WHERE id = ${input.sessionId}`).pipe(Effect.orDie)
  yield* events.remove(input.sessionId)
  if (prefix.length > 0) yield* events.replayAll(prefix, { ownerID: owner, strictOwner: true })
  if (memory.length > 0 && (yield* sessionRow(input.sessionId)))
    yield* SessionRequestMemoryRows.write(db, input.sessionId, memory).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("nests reconcile: request memory not written back", {
          "session.id": input.sessionId,
          cause,
        }),
      ),
    )
  const after = yield* StorageNests.ownerRow(input.sessionId)
  return {
    result: "forked",
    sessionId: input.sessionId,
    have: after?.seq ?? -1,
    owner,
    fork: { sessionId: made.sessionId, title, forkOf },
  } satisfies ReconcileResult
})

/**
 * t-tc2b6c: THE RUN LEASE. Every window's chat and the host engine are separate
 * engine processes on ONE store, and a turn's runner lives in the memory of the
 * process that runs it (session/run-state.ts). So "running" and "stop" go
 * through the store: while a turn runs, its engine keeps a row in `nest_run`
 * and writes its heartbeat every `RUN_BEAT_MS`. A row is live while its
 * heartbeat is younger than `RUN_TTL_MS`, so a crashed engine's row expires.
 * A release sets `stop` on the live rows, and the engine that holds a row stops
 * its turn at its next heartbeat.
 *
 * INERT like the other Nests tables: only a gated nest call, or a turn while
 * Nests is on (THE GATE below), creates the table.
 */
export const RUN_BEAT_MS = 1_000
export const RUN_TTL_MS = 10_000
/** How long a release waits for a turn in another engine to stop. */
export const RELEASE_WAIT_MS = 10_000

const RUN = sql.identifier("nest_run")

const ensureRunTable = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  yield* db
    .run(
      sql`CREATE TABLE IF NOT EXISTS ${RUN} (
        session_id TEXT NOT NULL,
        holder TEXT NOT NULL,
        pid INTEGER NOT NULL,
        heartbeat INTEGER NOT NULL,
        stop INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, holder))`,
    )
    .pipe(Effect.orDie)
})

/** Sessions with a turn running in some engine on this store. Rows of engines
 *  that stopped beating are deleted here. */
export const runningSessions = Effect.fn("StorageNestsHandover.runningSessions")(function* () {
  yield* ensureRunTable()
  const { db } = yield* Database.Service
  const cutoff = Date.now() - RUN_TTL_MS
  yield* db.run(sql`DELETE FROM ${RUN} WHERE heartbeat <= ${cutoff}`).pipe(Effect.orDie)
  const rows = yield* db
    .all<{ session_id: string }>(sql`SELECT DISTINCT session_id FROM ${RUN} WHERE heartbeat > ${cutoff}`)
    .pipe(Effect.orDie)
  return new Set(rows.map((row) => row.session_id))
})

export const runningHere = Effect.fnUntraced(function* (sessionID: string) {
  yield* ensureRunTable()
  const { db } = yield* Database.Service
  const row = yield* db
    .get<{
      n: number
    }>(sql`SELECT count(*) AS n FROM ${RUN} WHERE session_id = ${sessionID} AND heartbeat > ${Date.now() - RUN_TTL_MS}`)
    .pipe(Effect.orDie)
  return (row?.n ?? 0) > 0
})

/** The release's stop: every engine that runs `sessionID` stops it at its next
 *  heartbeat. `true` when a running turn was found. */
export const requestStop = Effect.fn("StorageNestsHandover.requestStop")(function* (sessionID: string) {
  yield* ensureRunTable()
  const { db } = yield* Database.Service
  const rows = yield* db
    .all<{ holder: string }>(
      sql`UPDATE ${RUN} SET stop = 1 WHERE session_id = ${sessionID} AND heartbeat > ${Date.now() - RUN_TTL_MS}
          RETURNING holder`,
    )
    .pipe(Effect.orDie)
  return rows.length > 0
})

/** Wait until no engine runs `sessionID`, at most `ms`. `true` when it stopped. */
export const awaitStopped = Effect.fn("StorageNestsHandover.awaitStopped")(function* (
  sessionID: string,
  ms = RELEASE_WAIT_MS,
) {
  const deadline = Date.now() + ms
  while (yield* runningHere(sessionID)) {
    if (Date.now() >= deadline) return false
    yield* Effect.sleep("100 millis")
  }
  return true
})

/**
 * THE GATE (lead review of t-tc2b6c). With Nests off nothing can release a
 * chat, so a turn does no lease work: no row, no heartbeat, no stop poll. The
 * engine does not get the host's `enabled` flag outside a nest call, so the
 * store keeps it: every gated nest call that passes writes `active-at` (at most
 * once a minute, see acp/nests.ts), and a turn starts its lease only when that
 * mark is younger than `ACTIVE_MS` (the host's nest tick runs every 30 s while
 * Nests is on). The check is one read at turn start, none while it runs.
 *
 * Nests turned on while a turn already runs: a gated call in THIS process
 * starts the lease of that turn (`wake`). A turn in another engine gets its
 * lease at its next turn; it cannot learn of the change without polling.
 */
export const ACTIVE_MS = 5 * 60_000
const ACTIVE_KEY = "active-at"

export const markActive = Effect.fn("StorageNestsHandover.markActive")(function* (at = Date.now()) {
  yield* StorageNests.writeSetting(ACTIVE_KEY, at)
})

/** One read, and no table is created: a store with Nests never on has none. */
const active = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const table = yield* db
    .get<{ n: number }>(sql`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'nest_setting'`)
    .pipe(Effect.orDie)
  if (!table?.n) return false
  const row = yield* db
    .get<{ value: string }>(sql`SELECT value FROM nest_setting WHERE key = ${ACTIVE_KEY}`)
    .pipe(Effect.orDie)
  const at = row ? Number(row.value) : NaN
  return Number.isFinite(at) && Date.now() - at < ACTIVE_MS
})

/** Turns in this process that run without a lease, waiting for `wake`. */
const waiting = new Set<Deferred.Deferred<void>>()

/** A gated nest call passed in this process: the turns waiting start theirs. */
export function wake() {
  for (const turn of waiting) Deferred.doneUnsafe(turn, Effect.void)
  waiting.clear()
}

/** One heartbeat: insert or refresh this turn's row (a stop already set is
 *  kept). `true` when a release asked this turn to stop. */
const beat = Effect.fnUntraced(function* (sessionID: string, holder: string) {
  const { db } = yield* Database.Service
  const row = yield* db
    .get<{ stop: number }>(
      sql`INSERT INTO ${RUN} (session_id, holder, pid, heartbeat) VALUES (${sessionID}, ${holder}, ${process.pid}, ${Date.now()})
          ON CONFLICT (session_id, holder) DO UPDATE SET heartbeat = excluded.heartbeat
          RETURNING stop`,
    )
    .pipe(Effect.orDie)
  return row?.stop === 1
})

const drop = Effect.fnUntraced(function* (sessionID: string, holder: string) {
  const { db } = yield* Database.Service
  yield* db.run(sql`DELETE FROM ${RUN} WHERE session_id = ${sessionID} AND holder = ${holder}`).pipe(Effect.orDie)
})

/** origami_change (t-w2qlop): the run leases this process holds now, for the
 *  elastic idle report. A stop while one is held leaves another engine's
 *  release waiting out RUN_TTL_MS. */
const heldLeases = new Set<string>()
ElasticActivity.probe("nest-lease", () => heldLeases)

/** A lease write never fails or stops the turn: a store error is logged. */
const quiet = <A>(fallback: A) =>
  Effect.catchCause((cause: Cause.Cause<never>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning("nests: run lease write failed", { cause }).pipe(Effect.as(fallback)),
  )

/**
 * THE HOOK (called from `session/run-state.ts`, `leased`): run `work` under a
 * lease on `sessionID` when Nests is on (see THE GATE). `stop` is the turn stop
 * (the one ACP `cancel` runs); it runs in a detached fiber, because it
 * interrupts the fiber that runs `work`, and so this heartbeat too.
 */
export function withRunLease<A, E, R>(sessionID: string, work: Effect.Effect<A, E, R>, stop: Effect.Effect<void>) {
  return Effect.gen(function* () {
    const holder = `${process.pid}:${crypto.randomUUID()}`
    let leased = false
    /** The table and the first row. `undefined` when the store refused them. */
    const open = Effect.gen(function* () {
      yield* ensureRunTable()
      leased = true
      heldLeases.add(holder)
      return yield* beat(sessionID, holder)
    }).pipe(quiet<boolean | undefined>(undefined))
    const beating = (stopped: boolean | undefined) =>
      Effect.gen(function* () {
        if (stopped === undefined) return
        while (!stopped) {
          yield* Effect.sleep(RUN_BEAT_MS)
          stopped = yield* beat(sessionID, holder).pipe(quiet(false))
        }
        yield* Effect.forkDetach(stop)
      })
    let woken: Deferred.Deferred<void> | undefined
    const fiber = (yield* active().pipe(quiet(false)))
      ? // The first row is written before the turn starts, so an index read
        // right after it already sees the turn.
        yield* Effect.forkChild(beating(yield* open))
      : yield* Effect.gen(function* () {
          const turn = yield* Deferred.make<void>()
          woken = turn
          waiting.add(turn)
          return yield* Effect.forkChild(Deferred.await(turn).pipe(Effect.andThen(open), Effect.flatMap(beating)))
        })
    return yield* work.pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (woken) waiting.delete(woken)
          yield* Fiber.interrupt(fiber)
          heldLeases.delete(holder)
          if (leased) yield* drop(sessionID, holder).pipe(quiet(undefined))
        }),
      ),
    )
  })
}

