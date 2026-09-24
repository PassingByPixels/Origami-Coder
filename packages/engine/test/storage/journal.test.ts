// Journal compaction (t-rz12wq). The claim under test is REPLAY EQUIVALENCE: the
// compacted journal, replayed into an empty store, must rebuild the session,
// message and part tables the original journal built - byte for byte, including
// the accumulated cost and token counters, which no single event carries.
//
// The journal is built by PUBLISHING through the real event service, not by
// hand-writing rows, so a schema or projector change shows up here rather than in
// the owner's store. The two replays run in one process against a wiped store
// rather than two files: what is being compared is the tables a replay produces,
// and the wipe is what makes the second replay a fresh one.

import { describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { MaxOpsBeforeYield } from "effect/Scheduler"
import { sql } from "drizzle-orm"

import { Database } from "@origami/core/database/database"
import { EventV2 } from "@origami/core/event"
import { SessionProjector } from "@origami/core/session/projector"
import { SessionV1 } from "@origami/core/v1/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { StorageJournal } from "../../src/storage/journal"
import { testEffect } from "../lib/effect"

const PROJECTED = ["part", "message", "session"] as const
const ALL = [...PROJECTED, "event", "event_sequence", "session_message", "session_input", "project"] as const

const truncate = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    for (const table of ALL) yield* db.run(sql`DELETE FROM ${sql.identifier(table)}`)
  }),
)
const truncateNode = LayerNode.make({
  name: "truncate-journal",
  layer: truncate,
  deps: [Database.node, SessionProjector.node],
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, truncateNode])),
)

const SESSION = SessionID.make("ses_journal_test")
const MESSAGE = MessageID.make("msg_journal_test")
const PARENT = MessageID.make("msg_journal_parent")

const info = (overrides: Partial<SessionV1.SessionInfo> = {}) =>
  ({
    id: SESSION,
    slug: "journal",
    projectID: "prj_journal",
    directory: "/tmp/journal",
    title: "A chat",
    version: "0.0.0",
    cost: 0,
    time: { created: 1_000, updated: 1_000 },
    ...overrides,
  }) as SessionV1.SessionInfo

const assistant = (overrides: Partial<SessionV1.Assistant> = {}) =>
  ({
    id: MESSAGE,
    sessionID: SESSION,
    role: "assistant",
    parentID: PARENT,
    modelID: "m",
    providerID: "p",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp/journal", root: "/tmp/journal" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_000, completed: 2_000 },
    ...overrides,
  }) as SessionV1.Assistant

const textPart = (id: string, text: string) =>
  ({
    id: PartID.make(id),
    messageID: MESSAGE,
    sessionID: SESSION,
    type: "text",
    text,
    time: { start: 1_000 },
  }) as SessionV1.Part

/**
 * The three projected tables as rows. `data` is parsed rather than compared as
 * text, because two replays of the SAME event re-encode its keys in schema order
 * and the live write kept publish order - a difference in the string, not in the
 * state. `time_updated` is dropped: it is a wall clock reading taken when the row
 * is written, and nothing in the journal determines it.
 */
const snapshot = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const tables: Record<string, unknown[]> = {}
  for (const table of PROJECTED) {
    const rows = yield* db
      .all<Record<string, unknown>>(sql`SELECT * FROM ${sql.identifier(table)} ORDER BY id`)
      .pipe(Effect.orDie)
    tables[table] = rows.map(({ time_updated: _, ...row }) => ({
      ...row,
      ...(typeof row.data === "string" ? { data: JSON.parse(row.data) } : {}),
    }))
  }
  return tables
})

// `data` comes back as the stored TEXT: this reads the table directly rather than
// through the drizzle json column, which is also how the sync handlers see it.
const journal = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const rows = yield* db
    .all<{ id: string; aggregate_id: string; seq: number; type: string; data: string }>(
      sql`SELECT id, aggregate_id, seq, type, data FROM ${sql.identifier("event")}
          WHERE aggregate_id = ${SESSION} ORDER BY seq`,
    )
    .pipe(Effect.orDie)
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }))
})

/** A chat the way the writer produces one: a session created and retitled, a
 *  message written twice, and parts rewritten many times as they stream. */
const write = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  yield* db
    .run(
      sql`INSERT INTO ${sql.identifier("project")} (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('prj_journal', '/tmp/journal', '[]', 1000, 1000)`,
    )
    .pipe(Effect.orDie)
  yield* events.publish(SessionV1.Event.Created, { sessionID: SESSION, info: info() })
  yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: SESSION, info: assistant() })
  // The `time` climbs with each rewrite, as it does live. The part row's
  // `time_created` comes from the FIRST event only, so a collapse that kept the
  // last event's `time` would move it.
  for (const [index, text] of ["He", "Hell", "Hello ther", "Hello there"].entries())
    yield* events.publish(SessionV1.Event.PartUpdated, {
      sessionID: SESSION,
      part: textPart("prt_a", text),
      time: 1_100 + index,
    })
  yield* events.publish(SessionV1.Event.Updated, { sessionID: SESSION, info: info({ title: "Renamed" }) })
  for (const text of ["Se", "Second"])
    yield* events.publish(SessionV1.Event.PartUpdated, {
      sessionID: SESSION,
      part: textPart("prt_b", text),
      time: 1_200,
    })
  // A step-finish part: its projector ACCUMULATES cost onto the session row, so
  // compaction must leave it alone.
  yield* events.publish(SessionV1.Event.PartUpdated, {
    sessionID: SESSION,
    part: {
      id: PartID.make("prt_step"),
      messageID: MESSAGE,
      sessionID: SESSION,
      type: "step-finish",
      reason: "stop",
      cost: 0.25,
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    } as SessionV1.Part,
    time: 1_300,
  })
  yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: SESSION, info: assistant({ cost: 0.25 }) })
  yield* events.publish(SessionV1.Event.Updated, { sessionID: SESSION, info: info({ title: "Renamed twice" }) })
})

/** Wipe everything a replay rebuilds, keeping the journal rows handed in. */
const reset = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  for (const table of ALL) yield* db.run(sql`DELETE FROM ${sql.identifier(table)}`).pipe(Effect.orDie)
  yield* db
    .run(
      sql`INSERT INTO ${sql.identifier("project")} (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('prj_journal', '/tmp/journal', '[]', 1000, 1000)`,
    )
    .pipe(Effect.orDie)
})

/** Replay journal rows into a wiped store and return the projected tables. */
const replay = Effect.fnUntraced(function* (rows: ReadonlyArray<Effect.Success<ReturnType<typeof journal>>[number]>) {
  const events = yield* EventV2.Service
  yield* reset()
  yield* events.replayAll(
    rows.map((row) => ({
      id: row.id as EventV2.ID,
      aggregateID: row.aggregate_id,
      seq: row.seq,
      type: row.type,
      data: row.data,
    })),
  )
  return yield* snapshot()
})

describe("journal compaction", () => {
  it.effect("replays to the same session, message and part tables", () =>
    Effect.gen(function* () {
      yield* write()
      const original = yield* journal()

      const result = yield* StorageJournal.compact({ dryRun: false, sessionID: SESSION })
      expect(result.compacted).toBe(1)
      const compacted = yield* journal()
      expect(compacted.length).toBeLessThan(original.length)
      // Contiguous from zero: the replay path refuses anything else.
      expect(compacted.map((row) => row.seq)).toEqual(compacted.map((_, index) => index))

      // Both journals are REPLAYED, so the comparison is replay against replay
      // and cannot pass by both sides sharing the live write's quirks.
      expect(yield* replay(compacted)).toEqual(yield* replay(original))
    }),
  )

  it.effect("keeps one event per part, message and session row", () =>
    Effect.gen(function* () {
      yield* write()
      yield* StorageJournal.compact({ dryRun: false, sessionID: SESSION })
      const rows = yield* journal()
      const count = (prefix: string) => rows.filter((row) => row.type.startsWith(prefix)).length
      // prt_a (4 -> 1), prt_b (2 -> 1), prt_step (1, never collapsed).
      expect(count("message.part.updated")).toBe(3)
      expect(count("message.updated")).toBe(1)
      expect(count("session.updated")).toBe(1)
      // The step-finish part is still there, with its usage intact.
      expect(rows.some((row) => JSON.stringify(row.data).includes("step-finish"))).toBe(true)
    }),
  )

  it.effect("measures without writing on a dry run", () =>
    Effect.gen(function* () {
      yield* write()
      const original = yield* journal()
      const dry = yield* StorageJournal.compact({ dryRun: true, sessionID: SESSION })
      expect(dry.dryRun).toBe(true)
      expect(dry.events.after).toBeLessThan(dry.events.before)
      expect(dry.bytes.after).toBeLessThan(dry.bytes.before)
      expect(yield* journal()).toEqual(original)
      // What the dry run promised is what the write delivers.
      const wet = yield* StorageJournal.compact({ dryRun: false, sessionID: SESSION })
      expect(wet.events.after).toBe(dry.events.after)
      expect(wet.bytes.after).toBe(dry.bytes.after)
    }),
  )

  it.effect("skips a session whose turn may still be running", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* write()
      // An assistant message with no `time.completed` is a turn in flight.
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: SESSION,
        info: assistant({ id: MessageID.make("msg_running"), time: { created: 3_000 } }),
      })
      const original = yield* journal()
      const result = yield* StorageJournal.compact({ dryRun: false, sessionID: SESSION })
      expect(result.skipped.running).toBe(1)
      expect(result.compacted).toBe(0)
      expect(yield* journal()).toEqual(original)
    }),
  )

  // t-tc2193. Two passes over one session at once (a Manager Compact and a
  // Nests export, or two exports). A plan read before the write transaction is
  // stale once the other pass has renumbered the journal: its UPDATE then
  // writes one row's payload into another row. `MaxOpsBeforeYield = 16` makes
  // the two fibers take turns every few steps, so both plan before either writes.
  it.effect("two compactions of one session at once leave a journal that replays the same", () =>
    Effect.gen(function* () {
      yield* write()
      const original = yield* journal()
      const results = yield* Effect.all(
        [
          StorageJournal.compact({ dryRun: false, sessionID: SESSION }),
          StorageJournal.compact({ dryRun: false, sessionID: SESSION }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.provideService(MaxOpsBeforeYield, 16))
      // One pass collapsed the journal; the other found nothing left to do.
      expect(results.map((result) => result.compacted).sort()).toEqual([0, 1])
      const compacted = yield* journal()
      expect(compacted.map((row) => row.seq)).toEqual(compacted.map((_, index) => index))
      const count = (prefix: string) => compacted.filter((row) => row.type.startsWith(prefix)).length
      expect(count("message.part.updated")).toBe(3)
      expect(count("message.updated")).toBe(1)
      expect(count("session.updated")).toBe(1)
      expect(yield* replay(compacted)).toEqual(yield* replay(original))
    }),
  )

  it.effect("skips a session another engine owns", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* write()
      yield* events.claim(SESSION, "wrk_other")
      const original = yield* journal()
      const result = yield* StorageJournal.compact({ dryRun: false, sessionID: SESSION })
      expect(result.skipped.owned).toBe(1)
      expect(yield* journal()).toEqual(original)
    }),
  )
})

describe("vacuum", () => {
  it.effect("refuses without an explicit confirm, and writes nothing", () =>
    Effect.gen(function* () {
      const result = yield* StorageJournal.vacuum({ confirm: false })
      expect(result.ran).toBe(false)
      expect(result.refused).toBe("unconfirmed")
      expect(result.reclaimedBytes).toBe(0)
    }),
  )

  it.effect("demands free space worth 1.5x the file", () =>
    Effect.gen(function* () {
      const result = yield* StorageJournal.vacuum({ confirm: true })
      expect(result.requiredBytes).toBe(Math.ceil(result.fileBytes * StorageJournal.FREE_SPACE_FACTOR))
      // This machine has room, so the guard passes and the VACUUM runs; the
      // refusal path is the one the number above decides.
      expect(result.ran).toBe(result.freeBytes >= result.requiredBytes)
      expect(result.refused).toBe(result.ran ? undefined : "free-space")
    }),
  )
})
