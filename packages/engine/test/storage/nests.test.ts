// Nests L4a (t-s9jgzh), store side. The claims under test:
//
// - ROUND TRIP: a session exported from store A in chunks and imported into a
//   SEPARATE store B has the same session, message and part rows on B as on A,
//   keeps its id, and is owned on B by desk A.
// - RESUME is receiver-driven and safe: a chunk past `have + 1` is refused with
//   `have`, a chunk sent twice changes nothing, a chunk from a different writer
//   or with a changed event is refused, not merged.
// - the index, the per-desk index table, storage classes and retention windows
//   behave as the wire contract says.
//
// Two real SQLite files, each with its own event service and projectors, so
// nothing on B can come from A except through the chunks.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@origami/core/database/database"
import { SessionV1 } from "@origami/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { StorageNests } from "../../src/storage/nests"
import { ArtifactStore } from "../../src/artifact/store"
import {
  CHILD,
  DESK_A,
  DESK_B,
  DESK_C,
  SESSION,
  type Store,
  bytes,
  exportAll,
  info,
  journal,
  nextDir,
  on,
  ownerOf,
  part,
  rows,
  state,
  storeLayer,
  wire,
  withStores,
  write,
} from "./nests-fixture"

describe("nest export and import", () => {
  test("round trip: the rows on B are the rows on A, owned by A", () =>
    withStores((a, b) =>
      Effect.gen(function* () {
        yield* on(a, write())
        // A small budget, so the session crosses in several chunks.
        const chunks = yield* on(a, exportAll(600))
        expect(chunks.length).toBeGreaterThan(2)
        // The ranges tile the journal with no hole and no overlap.
        expect(chunks[0]!.from).toBe(0)
        for (const [index, chunk] of chunks.entries()) {
          expect(chunk.events.map((event) => event.seq)).toEqual(chunk.events.map((_, offset) => chunk.from + offset))
          if (index > 0) expect(chunk.from).toBe(chunks[index - 1]!.to + 1)
        }
        expect(chunks[0]!.project?.id as string | undefined).toBe("prj_nests")
        expect(chunks.slice(1).every((chunk) => chunk.project === undefined)).toBe(true)

        for (const chunk of chunks) {
          const result = yield* on(b, StorageNests.importChunk({ deviceId: DESK_B, chunk: wire(chunk) }))
          expect(result.refused).toBeUndefined()
          expect(result.have).toBe(chunk.to)
        }

        const onA = yield* on(a, rows())
        const onB = yield* on(b, rows())
        expect(onB.part).toHaveLength(3)
        expect(state(onB)).toEqual(state(onA))
        // The journal crosses byte for byte: same ids, seqs, types and payload text.
        expect(yield* on(b, journal())).toEqual(yield* on(a, journal()))
        expect(yield* on(a, ownerOf())).toBe(DESK_A)
        expect(yield* on(b, ownerOf())).toBe(DESK_A)

        // On B the session keeps its id, is held by B and written by A.
        const index = yield* on(
          b,
          StorageNests.index({ deviceId: DESK_B, deskName: "MacBook", running: new Set([SESSION]), open: new Set() }),
        )
        expect(index).toHaveLength(1)
        expect(index[0]).toMatchObject({ id: SESSION, desk: DESK_B, owner: DESK_A, title: "Renamed twice" })
        // Written by another desk, so it cannot be running here.
        expect(index[0]!.state).toBe("closed")
        expect(yield* on(b, StorageNests.foreignOwner({ deviceId: DESK_B, sessionId: SESSION }))).toBe(DESK_A)
        expect(yield* on(a, StorageNests.foreignOwner({ deviceId: DESK_A, sessionId: SESSION }))).toBeUndefined()
      }),
    ))

  test("two receivers, different chunk sizes: byte-identical rows", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const a = (yield* Layer.build(storeLayer())) as Store
          const b = (yield* Layer.build(storeLayer())) as Store
          const c = (yield* Layer.build(storeLayer())) as Store
          yield* on(a, write())
          for (const chunk of yield* on(a, exportAll(600)))
            yield* on(b, StorageNests.importChunk({ deviceId: DESK_B, chunk: wire(chunk) }))
          const [whole] = yield* on(a, exportAll(1 << 20))
          const result = yield* on(c, StorageNests.importChunk({ deviceId: DESK_C, chunk: wire(whole!) }))
          expect(result).toMatchObject({ done: true, applied: whole!.events.length })
          expect(bytes(yield* on(c, rows()))).toEqual(bytes(yield* on(b, rows())))
        }),
      ),
    ))

  test("the first export compacts and claims; later exports keep the numbering", () =>
    withStores((a) =>
      Effect.gen(function* () {
        yield* on(a, write())
        const before = yield* on(a, journal())
        const first = yield* on(
          a,
          StorageNests.exportChunk({ deviceId: DESK_A, sessionId: SESSION, after: -1, maxBytes: 1 << 20 }),
        )
        const after = yield* on(a, journal())
        // prt_a's four rows collapse to one; the two session.updated rows to one.
        expect(after.length).toBeLessThan(before.length)
        expect("refused" in first ? [] : first.events.map((event) => event.id as string)).toEqual(
          after.map((row) => row.id),
        )
        expect(yield* on(a, ownerOf())).toBe(DESK_A)
        // A second export must not compact again: a receiver holds these seqs.
        yield* on(a, StorageNests.exportChunk({ deviceId: DESK_A, sessionId: SESSION, after: -1, maxBytes: 1 << 20 }))
        expect(yield* on(a, journal())).toEqual(after)
      }),
    ))

  test("refuses a gap with `have`, and a chunk sent twice changes nothing", () =>
    withStores((a, b) =>
      Effect.gen(function* () {
        yield* on(a, write())
        const [first, second, third] = yield* on(a, exportAll(600))
        yield* on(b, StorageNests.importChunk({ deviceId: DESK_B, chunk: wire(first!) }))
        const gap = yield* on(b, StorageNests.importChunk({ deviceId: DESK_B, chunk: wire(third!) }))
        expect(gap).toMatchObject({ refused: "gap", have: first!.to, applied: 0 })

        const again = yield* on(b, StorageNests.importChunk({ deviceId: DESK_B, chunk: wire(first!) }))
        expect(again).toMatchObject({ have: first!.to, applied: 0 })
        expect(again.refused).toBeUndefined()

        // An empty chunk asks only for `have`: the first message of a pull.
        const ask = yield* on(
          b,
          StorageNests.importChunk({ deviceId: DESK_B, chunk: { ...first!, events: [], project: undefined } }),
        )
        expect(ask).toMatchObject({ have: first!.to, applied: 0 })

        const next = yield* on(b, StorageNests.importChunk({ deviceId: DESK_B, chunk: wire(second!) }))
        expect(next).toMatchObject({ have: second!.to, applied: second!.events.length })
      }),
    ))

  test("refuses a chunk from another writer, and one whose event changed", () =>
    withStores((a, b) =>
      Effect.gen(function* () {
        yield* on(a, write())
        const [first] = yield* on(a, exportAll(600))
        yield* on(b, StorageNests.importChunk({ deviceId: DESK_B, chunk: wire(first!) }))
        const held = yield* on(b, journal())

        const stolen = { ...(wire(first!) as StorageNests.Chunk), owner: DESK_C }
        expect(yield* on(b, StorageNests.importChunk({ deviceId: DESK_B, chunk: stolen }))).toMatchObject({
          refused: "owner",
          applied: 0,
        })

        const changed = wire(first!) as StorageNests.Chunk & { events: { data: Record<string, unknown> }[] }
        // A field the schema keeps: an unknown key would be dropped by the decode
        // and the event would still be the same one.
        const created = changed.events[0]!.data as { info: Record<string, unknown> }
        created.info = { ...created.info, title: "Not the same event" }
        const diverged = yield* on(b, StorageNests.importChunk({ deviceId: DESK_B, chunk: changed }))
        expect(diverged.refused).toBe("diverged")
        expect(yield* on(b, journal())).toEqual(held)

        // A hole inside one chunk is a broken sender.
        const holed = wire(first!) as StorageNests.Chunk & { events: { seq: number }[] }
        holed.events[1]!.seq += 5
        expect((yield* on(b, StorageNests.importChunk({ deviceId: DESK_B, chunk: holed }))).refused).toBe("bad-chunk")
      }),
    ))

  test("refuses to export a session with no journal", () =>
    withStores((a) =>
      Effect.gen(function* () {
        const result = yield* on(
          a,
          StorageNests.exportChunk({ deviceId: DESK_A, sessionId: "ses_missing", after: -1, maxBytes: 1024 }),
        )
        expect(result).toEqual({ refused: "not-found", sessionId: "ses_missing" })
      }),
    ))

  // L6 (t-selspn): the mother base TAILS a chat. It holds a read-only copy, the
  // owner writes on, and the next pull brings only the later range. The earlier
  // journal rows and the projected rows they made must stay as they were.
  test("a later chunk range appends onto an existing read-only copy without touching earlier rows", () =>
    withStores((a, b) =>
      Effect.gen(function* () {
        yield* on(a, write())
        for (const chunk of yield* on(a, exportAll(600)))
          yield* on(b, StorageNests.importChunk({ deviceId: DESK_B, chunk: wire(chunk) }))
        const heldJournal = yield* on(b, journal())
        const heldParts = (yield* on(b, rows())).part as Record<string, unknown>[]
        const have = heldJournal.at(-1)!.seq

        // The owner writes on: a new part that streams (three rewrites) and a retitle.
        yield* on(
          a,
          Effect.gen(function* () {
            const events = yield* EventV2Bridge.Service
            for (const [index, text] of ["Fol", "Follow", "Follow-up answer"].entries())
              yield* events.publish(SessionV1.Event.PartUpdated, {
                sessionID: SESSION,
                part: part("prt_c", { type: "text", text, time: { start: 2_000 } }),
                time: 2_100 + index,
              })
            yield* events.publish(SessionV1.Event.Updated, { sessionID: SESSION, info: info({ title: "Third title" }) })
          }),
        )
        const later = yield* on(a, exportAll(600, DESK_A, have))
        expect(later.length).toBeGreaterThan(0)
        expect(later[0]!.from).toBe(have + 1)
        for (const chunk of later) {
          const result = yield* on(b, StorageNests.importChunk({ deviceId: DESK_B, chunk: wire(chunk) }))
          expect(result.refused).toBeUndefined()
          expect(result.have).toBe(chunk.to)
        }

        const onB = yield* on(b, journal())
        // Earlier rows: byte for byte what the copy held before the later range.
        expect(onB.slice(0, heldJournal.length)).toEqual(heldJournal)
        expect(onB).toEqual(yield* on(a, journal()))
        expect(state(yield* on(b, rows()))).toEqual(state(yield* on(a, rows())))
        // The parts the earlier range made were not rewritten (same write clock too).
        const after = (yield* on(b, rows())).part as Record<string, unknown>[]
        for (const held of heldParts) expect(after.find((row) => row["id"] === held["id"])).toEqual(held)
        expect(after.find((row) => row["id"] === "prt_c")).toBeDefined()
        // Still a read-only copy of A's chat.
        expect(yield* on(b, ownerOf())).toBe(DESK_A)
        expect(yield* on(b, StorageNests.foreignOwner({ deviceId: DESK_B, sessionId: SESSION }))).toBe(DESK_A)
      }),
    ))
})

describe("nest index", () => {
  test("rows from the session tables: state, lastAt, forkOf, size, seq; root sessions only", () =>
    withStores((a) =>
      Effect.gen(function* () {
        yield* on(a, write())
        const events = yield* on(a, EventV2Bridge.Service)
        yield* on(
          a,
          events.publish(SessionV1.Event.Created, {
            sessionID: CHILD,
            info: info({ id: CHILD, parentID: SESSION, title: "A sub-agent" }),
          }),
        )
        yield* on(
          a,
          events.publish(SessionV1.Event.Updated, {
            sessionID: SESSION,
            info: info({ title: "Forked", metadata: { forkOf: { id: "ses_parent", desk: DESK_C, at: 42 } } }),
          }),
        )
        const read = (running: string[], open: string[]) =>
          on(
            a,
            StorageNests.index({ deviceId: DESK_A, deskName: "5090", running: new Set(running), open: new Set(open) }),
          )
        const [row] = yield* read([], [])
        const held = yield* on(a, journal())
        expect(row).toEqual({
          id: SESSION,
          title: "Forked",
          desk: DESK_A,
          deskName: "5090",
          state: "closed",
          // Never exported: no owner row yet, so this desk is the writer.
          owner: DESK_A,
          lastAt: 5_000,
          forkOf: { id: "ses_parent", desk: DESK_C, at: 42 },
          size: held.reduce((sum, event) => sum + event.data.length, 0),
          seq: held.at(-1)!.seq,
        })
        expect((yield* read([], [SESSION]))[0]!.state).toBe("open")
        expect((yield* read([SESSION], [SESSION]))[0]!.state).toBe("running")
      }),
    ))

  // t-sj2qkr: the Mac evidence rows — a blank "New session - <ISO>" placeholder
  // with zero messages must never export, unless it is genuinely running now.
  test("a blank 'New session' row is not exported unless it is running", () =>
    withStores((a) =>
      Effect.gen(function* () {
        // write() creates the project row (a session needs its project to
        // exist for the FK) plus the unrelated real-titled SESSION fixture.
        yield* on(a, write())
        const events = yield* on(a, EventV2Bridge.Service)
        const BLANK = SessionID.make("ses_blank_test")
        yield* on(
          a,
          events.publish(SessionV1.Event.Created, {
            sessionID: BLANK,
            info: info({ id: BLANK, title: "New session - 2026-09-22T22:36:36.232Z" }),
          }),
        )
        const read = (running: string[]) =>
          on(a, StorageNests.index({ deviceId: DESK_A, deskName: "5090", running: new Set(running), open: new Set() }))
        expect((yield* read([])).map((r) => r.id)).not.toContain(BLANK)
        const live = yield* read([BLANK])
        expect(live.find((r) => r.id === BLANK)).toMatchObject({ id: BLANK, state: "running" })
      }),
    ))

  test("a real chat is exported even with a single message and no reply", () =>
    withStores((a) =>
      Effect.gen(function* () {
        yield* on(a, write())
        const events = yield* on(a, EventV2Bridge.Service)
        const REAL = SessionID.make("ses_real_test")
        yield* on(
          a,
          events.publish(SessionV1.Event.Created, {
            sessionID: REAL,
            info: info({ id: REAL, title: "Greeting and quick check-in" }),
          }),
        )
        const rows = yield* on(
          a,
          StorageNests.index({ deviceId: DESK_A, deskName: "5090", running: new Set(), open: new Set() }),
        )
        expect(rows.map((r) => r.id)).toContain(REAL)
      }),
    ))
})

describe("nest apply index", () => {
  const row = (overrides: Partial<StorageNests.NestIndexRow> = {}): StorageNests.NestIndexRow => ({
    id: "ses_one",
    title: "One",
    desk: DESK_A,
    deskName: "5090",
    state: "open",
    owner: DESK_A,
    lastAt: 10,
    size: 100,
    seq: 5,
    ...overrides,
  })

  test("idempotent by (desk, id, seq); late rows dropped; own and malformed rows rejected", () =>
    withStores((_, b) =>
      Effect.gen(function* () {
        const apply = (rows: unknown[], replace = false) =>
          on(b, StorageNests.applyIndex({ deviceId: DESK_B, desk: DESK_A, rows, replace }))
        expect(yield* apply([row(), row({ id: "ses_two" })])).toMatchObject({ inserted: 2 })
        expect(yield* apply([row(), row({ id: "ses_two" })])).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 })
        // Same seq, new state: a turn ended without a journal write.
        expect(yield* apply([row({ state: "closed" })])).toMatchObject({ updated: 1 })
        expect(yield* apply([row({ seq: 4, title: "Old" })])).toMatchObject({ stale: 1 })
        expect(yield* apply([row({ desk: DESK_C }), { id: "ses_bad" }, row({ state: "gone" as never })])).toMatchObject(
          { rejected: 3 },
        )
        const own = yield* on(
          b,
          StorageNests.applyIndex({ deviceId: DESK_B, desk: DESK_B, rows: [row({ desk: DESK_B })], replace: false }),
        )
        expect(own.rejected).toBe(1)

        const others = yield* on(b, StorageNests.foreignIndex({ deviceId: DESK_B }))
        expect(others).toEqual([row({ state: "closed" }), row({ id: "ses_two" })])

        // A full index that no longer lists ses_two: it was deleted on A.
        expect(yield* apply([row({ state: "closed" })], true)).toMatchObject({ removed: 1 })
        expect(yield* on(b, StorageNests.foreignIndex({ deviceId: DESK_B }))).toEqual([row({ state: "closed" })])
      }),
    ))

  // t-z6nt1b: the owner's first export compacts the journal and LOWERS its seq
  // (owner index seq 21 -> journal 15, PC store 2026-09-26). A full index is the
  // desk's current truth, so a lower seq in it must not freeze the held row.
  test("a full index with a lower seq (compacted journal) still replaces the row", () =>
    withStores((_, b) =>
      Effect.gen(function* () {
        const apply = (rows: unknown[], replace: boolean) =>
          on(b, StorageNests.applyIndex({ deviceId: DESK_B, desk: DESK_A, rows, replace }))
        yield* apply([row({ seq: 21, state: "open" })], true)
        expect(yield* apply([row({ seq: 15, state: "closed" })], true)).toMatchObject({ updated: 1, stale: 0 })
        expect(yield* on(b, StorageNests.foreignIndex({ deviceId: DESK_B }))).toEqual([row({ seq: 15, state: "closed" })])
        // A partial (non-full) message with a lower seq is still a late one and is dropped.
        expect(yield* apply([row({ seq: 9, state: "open" })], false)).toMatchObject({ stale: 1 })
      }),
    ))

  // t-sj2qkr: a row an older desk already stored (before this rule existed)
  // is hidden on READ, not migrated or deleted — a later read of the raw
  // table still finds it.
  test("foreignIndex hides an already-stored turnless row, unless it is running", () =>
    withStores((_, b) =>
      Effect.gen(function* () {
        const blankClosed = row({ id: "ses_blank_old", title: "New session - 2026-09-04T19:05:22.284Z", state: "closed" })
        const blankRunning = row({ id: "ses_blank_running", title: "New session - 2026-09-22T22:36:36.232Z", state: "running" })
        yield* on(
          b,
          StorageNests.applyIndex({ deviceId: DESK_B, desk: DESK_A, rows: [blankClosed, blankRunning, row()], replace: false }),
        )
        const shown = yield* on(b, StorageNests.foreignIndex({ deviceId: DESK_B }))
        expect(shown.map((r) => r.id).sort()).toEqual(["ses_blank_running", "ses_one"])
        const { db } = yield* on(b, Database.Service)
        const stored = yield* on(
          b,
          db.get<{ n: number }>(sql`SELECT count(*) AS n FROM ${sql.identifier("nest_index")} WHERE id = 'ses_blank_old'`).pipe(Effect.orDie),
        )
        expect(stored?.n).toBe(1)
      }),
    ))

  test("drops keys a peer adds to a row", () =>
    withStores((_, b) =>
      Effect.gen(function* () {
        yield* on(
          b,
          StorageNests.applyIndex({
            deviceId: DESK_B,
            desk: DESK_A,
            rows: [{ ...row(), html: "<img>" }],
            replace: false,
          }),
        )
        expect(yield* on(b, StorageNests.foreignIndex({ deviceId: DESK_B }))).toEqual([row()])
      }),
    ))
})

// t-t7l3pa: a desk that re-paired with a new id kept its own chats under the
// OLD id, so its index reported a stranger as their writer and the read-only
// guard refused them on the desk that wrote them.
describe("nest device re-attribution", () => {
  const OLD = "deskOLDOLDO"
  const NEW = "deskNEWNEWN"
  const FOREIGN = "ses_nests_foreign"

  test("a new device id takes over the rows the previous local id owns, once; a foreign owner is untouched", () =>
    withStores((a) =>
      Effect.gen(function* () {
        const { db } = yield* on(a, Database.Service)
        // A chat another desk writes, held here as a copy (its owner row only).
        yield* on(
          a,
          db
            .run(sql`INSERT INTO ${sql.identifier("event_sequence")} (aggregate_id, seq, owner_id) VALUES (${FOREIGN}, 3, ${DESK_C})`)
            .pipe(Effect.orDie),
        )
        // The first id this store hears of has nothing before it: nothing moves.
        yield* on(a, StorageNests.rememberDevice({ deviceId: OLD, deskName: "MacBook" }))
        expect(yield* on(a, ownerOf(FOREIGN))).toBe(DESK_C)
        // This desk writes a chat, and its first export claims it with the OLD id.
        yield* on(a, write())
        yield* on(a, exportAll(1 << 20, OLD))
        expect(yield* on(a, ownerOf())).toBe(OLD)
        expect(yield* on(a, StorageNests.foreignOwner({ deviceId: NEW, sessionId: SESSION }))).toBe(OLD)

        // The desk re-paired: the host now names it NEW.
        yield* on(a, StorageNests.rememberDevice({ deviceId: NEW, deskName: "MacBook" }))
        expect(yield* on(a, ownerOf())).toBe(NEW)
        expect(yield* on(a, ownerOf(FOREIGN))).toBe(DESK_C)
        expect(yield* on(a, StorageNests.foreignOwner({ deviceId: NEW, sessionId: SESSION }))).toBeUndefined()
        const [own] = yield* on(a, StorageNests.index({ deviceId: NEW, deskName: "MacBook", running: new Set([SESSION]), open: new Set() }))
        expect(own).toMatchObject({ id: SESSION, desk: NEW, owner: NEW, state: "running" })
        // The export after the move carries the new writer.
        const [chunk] = yield* on(a, exportAll(1 << 20, NEW))
        expect(chunk!.owner).toBe(NEW)

        // Idempotent: the same id again moves nothing, and the old id is not revived.
        yield* on(a, StorageNests.rememberDevice({ deviceId: NEW, deskName: "MacBook" }))
        expect(yield* on(a, ownerOf())).toBe(NEW)
        expect(yield* on(a, ownerOf(FOREIGN))).toBe(DESK_C)
        const held = yield* on(
          a,
          db
            .all<{ owner_id: string | null }>(sql`SELECT owner_id FROM ${sql.identifier("event_sequence")} ORDER BY aggregate_id`)
            .pipe(Effect.orDie),
        )
        expect(held.map((row) => row.owner_id).sort()).toEqual([DESK_C, NEW].sort())
      }),
    ))
})

const DAY_MS = 86_400_000

describe("nest storage and retention", () => {
  test("classes are disjoint: tool output is counted once, chats and sub-agents without it", () =>
    withStores((a) =>
      Effect.gen(function* () {
        yield* on(a, write())
        const dir = nextDir("artifacts")
        mkdirSync(path.join(dir, "blobs"), { recursive: true })
        writeFileSync(path.join(dir, "artifacts.db"), "x".repeat(300))
        writeFileSync(path.join(dir, "blobs", "abc"), "y".repeat(200))
        const result = yield* on(a, StorageNests.storage({ deviceId: DESK_A, artifactsDir: dir }))
        const { db } = yield* on(a, Database.Service)
        const bodies = yield* on(
          a,
          db
            .get<{
              m: number
              p: number
            }>(sql`SELECT (SELECT sum(length(data)) FROM message) AS m, (SELECT sum(length(data)) FROM part) AS p`)
            .pipe(Effect.orDie),
        )
        expect(result.classes.toolOutput).toBe(400)
        expect(result.classes.subagents).toBe(0)
        expect(result.classes.chats).toBe(bodies!.m + bodies!.p - 400)
        expect(result.classes.artifacts).toBe(500)
        expect(result.classes.journal).toBe((yield* on(a, journal())).reduce((sum, row) => sum + row.data.length, 0))
        // prt_a streamed 4 times, the tool and step parts once: 6 events, 3 parts.
        expect(result.journalEventsPerPart).toBe(2)
      }),
    ))

  // t-vbivj4: the measure was three whole-table statements. bun:sqlite is
  // synchronous, so on the owner's 15 GB store copy the engine's event loop
  // stood still for 44-52 s and the Storage card sat on "Measuring...". Now it
  // reads in ranges and gives the loop a turn between them.
  test("the measure gives the event loop turns while it reads, and reports partial sums", () =>
    withStores((a) =>
      Effect.gen(function* () {
        yield* on(a, write())
        let turned = false
        setImmediate(() => {
          turned = true
        })
        const partials: StorageNests.StorageResult[] = []
        const result = yield* on(
          a,
          StorageNests.storage({
            deviceId: DESK_A,
            artifactsDir: nextDir("artifacts"),
            sliceRows: 1,
            onPartial: (partial) => partials.push(partial),
          }),
        )
        expect(turned).toBe(true)
        expect(partials.length).toBeGreaterThan(3)
        expect(partials.every((partial) => partial.done === false)).toBe(true)
        const progress = partials.map((partial) => partial.progress)
        expect(progress).toEqual([...progress].sort((x, y) => x - y))
        expect(progress[0]).toBeGreaterThan(0)
        expect(result.done).toBe(true)
        expect(result.progress).toBe(1)
        expect(partials.at(-1)!.classes).toEqual(result.classes)
      }),
    ))

  test("sizes are bytes, and the same whatever the range size", () =>
    withStores((a) =>
      Effect.gen(function* () {
        yield* on(a, write())
        const { db } = yield* on(a, Database.Service)
        // Two-byte characters (char(233) is e-acute): bytes, not characters.
        yield* on(
          a,
          db
            .run(sql`UPDATE ${sql.identifier("message")} SET data = json_set(data, '$.note', 'h' || char(233) || 'llo')`)
            .pipe(Effect.orDie),
        )
        const dir = nextDir("artifacts")
        const whole = yield* on(a, StorageNests.storage({ deviceId: DESK_A, artifactsDir: dir }))
        const small = yield* on(
          a,
          StorageNests.storage({ deviceId: DESK_A, artifactsDir: dir, sliceRows: 2, sliceBytes: 64 }),
        )
        const bytes = yield* on(
          a,
          db
            .get<{ m: number; p: number; e: number }>(
              sql`SELECT (SELECT sum(octet_length(data)) FROM message) AS m, (SELECT sum(octet_length(data)) FROM part) AS p,
                (SELECT sum(octet_length(data)) FROM event) AS e`,
            )
            .pipe(Effect.orDie),
        )
        expect(small.classes).toEqual(whole.classes)
        expect(whole.classes.chats + whole.classes.toolOutput).toBe(bytes!.m + bytes!.p)
        expect(whole.classes.journal).toBe(bytes!.e)
      }),
    ))

  test("a huge tool part counts in full as tool output, from its first bytes", () =>
    withStores((a) =>
      Effect.gen(function* () {
        yield* on(a, write())
        const { db } = yield* on(a, Database.Service)
        const tool = yield* on(
          a,
          db
            .get<{
              n: number
              head: string
            }>(sql`SELECT octet_length(data) AS n, substr(data, 1, 14) AS head FROM ${sql.identifier("part")} WHERE id = 'prt_tool'`)
            .pipe(Effect.orDie),
        )
        expect(tool!.head).toBe('{"type":"tool"')
        const dir = nextDir("artifacts")
        const parsed = yield* on(a, StorageNests.storage({ deviceId: DESK_A, artifactsDir: dir }))
        const huge = yield* on(a, StorageNests.storage({ deviceId: DESK_A, artifactsDir: dir, hugeBytes: tool!.n - 1 }))
        expect(parsed.classes.toolOutput).toBe(400)
        expect(huge.classes.toolOutput).toBe(tool!.n)
        expect(huge.classes.chats + huge.classes.toolOutput).toBe(parsed.classes.chats + parsed.classes.toolOutput)
      }),
    ))

  test("windows: stored per class, raised to the floor, null keeps everything, apply prunes tool output", () =>
    withStores((a) =>
      Effect.gen(function* () {
        const empty = yield* on(a, StorageNests.retention({}))
        expect(empty.windows).toEqual({
          chats: null,
          subagents: null,
          toolOutput: null,
          journal: null,
          artifacts: null,
        })
        expect(empty.unapplied).toEqual([])

        const set = yield* on(a, StorageNests.retention({ set: { toolOutput: 2, chats: 30 } }))
        expect(set.windows).toMatchObject({ toolOutput: 7, chats: 30, subagents: null })
        expect(set.unapplied).toEqual(["chats"])
        // A set that does not name a class leaves it alone; null clears one.
        const merged = yield* on(a, StorageNests.retention({ set: { chats: null } }))
        expect(merged.windows).toMatchObject({ toolOutput: 7, chats: null })
        expect((yield* on(a, StorageNests.retention({}))).windows).toEqual(merged.windows)

        const applied = yield* on(a, StorageNests.retention({ apply: { dryRun: true } }))
        expect(applied.applied?.toolOutput).toMatchObject({ dryRun: true, olderThanDays: 7 })
      }),
    ))

  // t-vb87lt: artifacts were a class with a Keep window that no prune read.
  // A real store in a temp dir: versions are made on a clock set back, then the
  // window is applied through `retention` with today's clock.
  test("the artifacts window removes only the files of versions older than it; the newest version keeps its files", () =>
    withStores((a) =>
      Effect.gen(function* () {
        const dir = nextDir("artifacts")
        const now = Date.now()
        let clock = 0
        const made = yield* Effect.promise(() => ArtifactStore.open(dir, { now: () => clock }))
        const page = (text: string) => [{ path: "index.html", bytes: new TextEncoder().encode(text) }]
        const publish = (daysAgo: number, text: string, artifactId?: string, base?: number) => {
          clock = now - daysAgo * DAY_MS
          const r = made.publish({
            ...(artifactId ? { artifactId } : {}),
            title: "page",
            files: page(text),
            baseVersion: base ?? "absent",
            idempotencyKey: text,
          })
          return (r as { artifactId: string }).artifactId
        }
        // A: v1 50 days old, v2 40, v3 10 (the newest). B: one version, 60 days old.
        const A = publish(50, "A-v1-50d")
        publish(40, "A-v2-40d", A, 1)
        publish(10, "A-v3-10d", A, 2)
        const B = publish(60, "B-v1-60d")
        const file = (id: string, n: number) => made.get(id, n)!.entries[0]!.sha256
        const sha = { a1: file(A, 1), a2: file(A, 2), a3: file(A, 3), b1: file(B, 1) }
        made.close()
        const has = (s: string) => existsSync(path.join(dir, "blobs", s))

        // Dry runs with the card's choice: counted, nothing removed, nothing stored.
        const at45 = yield* on(
          a,
          StorageNests.retention({ apply: { dryRun: true, windows: { artifacts: 45 } }, artifactsDir: dir }),
        )
        expect(at45.applied?.artifacts).toEqual({ dryRun: true, olderThanDays: 45, blobs: 1, bytes: 8 })
        const at30 = yield* on(
          a,
          StorageNests.retention({ apply: { dryRun: true, windows: { artifacts: 30 } }, artifactsDir: dir }),
        )
        expect(at30.applied?.artifacts).toMatchObject({ blobs: 2, bytes: 16 })
        expect(at30.windows.artifacts).toBeNull()
        expect(at30.unapplied).toEqual([])
        expect(Object.values(sha).every(has)).toBe(true)

        // Apply: v1 and v2 of A lose their files. A v3 is in the window; B v1 is
        // older than it but is B's newest version, so it keeps its file.
        const done = yield* on(
          a,
          StorageNests.retention({ set: { artifacts: 30 }, apply: { dryRun: false }, artifactsDir: dir }),
        )
        expect(done.windows.artifacts).toBe(30)
        expect(done.applied?.artifacts).toEqual({ dryRun: false, olderThanDays: 30, blobs: 2, bytes: 16 })
        expect([has(sha.a1), has(sha.a2), has(sha.a3), has(sha.b1)]).toEqual([false, false, true, true])
        // Every version keeps its row: the history still lists all of them.
        const after = yield* Effect.promise(() => ArtifactStore.open(dir))
        expect(after.sizeReport()).toMatchObject({ artifacts: 2, versions: 4 })
        after.close()
      }),
    ))

  // t-vs5krz: the artifact folder was summed with readdirSync + statSync, in one
  // block before the first range: 284-439 ms at 30,000 blobs (soak, store copy).
  // A macrotask chain counts the loop turns before the first range is read: the
  // blocking walk left none.
  test("the artifact folder is summed without holding the event loop", () =>
    withStores((a) =>
      Effect.gen(function* () {
        yield* on(a, write())
        const dir = nextDir("artifacts")
        mkdirSync(path.join(dir, "blobs", "incoming"), { recursive: true })
        writeFileSync(path.join(dir, "artifacts.db"), "x".repeat(300))
        for (let i = 0; i < 400; i++) writeFileSync(path.join(dir, "blobs", `b${i}`), "y".repeat(10))
        writeFileSync(path.join(dir, "blobs", "incoming", "part"), "z".repeat(7))
        let turns = 0
        let spinning = true
        const spin = () => {
          turns++
          if (spinning) setImmediate(spin)
        }
        setImmediate(spin)
        let beforeFirstRange = -1
        const result = yield* on(
          a,
          StorageNests.storage({
            deviceId: DESK_A,
            artifactsDir: dir,
            onPartial: () => {
              if (beforeFirstRange < 0) beforeFirstRange = turns
            },
          }),
        )
        spinning = false
        expect(result.classes.artifacts).toBe(300 + 400 * 10 + 7)
        expect(beforeFirstRange).toBeGreaterThan(0)
      }),
    ))

  // t-vs5krz: the artifact dry run listed and stat'ed every blob in one block
  // (+0.3-0.5 s at 30,000 blobs in the soak). Only the dry run: an Apply keeps
  // its one pass (t-veeliu).
  test("the artifact dry run counts blobs without holding the event loop", () =>
    withStores((a) =>
      Effect.gen(function* () {
        const dir = nextDir("artifacts")
        const made = yield* Effect.promise(() => ArtifactStore.open(dir))
        made.close()
        // Blobs no version names: all of them are what a prune frees.
        for (let i = 0; i < 300; i++)
          writeFileSync(path.join(dir, "blobs", i.toString(16).padStart(64, "0")), "b".repeat(i % 7))
        // Not a blob: a publish that died mid-write. Never counted.
        writeFileSync(path.join(dir, "blobs", `${"f".repeat(64)}.123.tmp`), "t".repeat(50))
        let turns = 0
        let spinning = true
        const spin = () => {
          turns++
          if (spinning) setImmediate(spin)
        }
        setImmediate(spin)
        const result = yield* on(
          a,
          StorageNests.retention({ apply: { dryRun: true, windows: { artifacts: 30 } }, artifactsDir: dir }),
        )
        spinning = false
        const bytes = Array.from({ length: 300 }, (_, i) => i % 7).reduce((sum, n) => sum + n, 0)
        expect(result.applied?.artifacts).toEqual({ dryRun: true, olderThanDays: 30, blobs: 300, bytes })
        expect(turns).toBeGreaterThan(0)
      }),
    ))

  test("a desk with no artifact store prunes nothing and gets no store", () =>
    withStores((a) =>
      Effect.gen(function* () {
        const dir = nextDir("artifacts")
        const result = yield* on(a, StorageNests.retention({ apply: { dryRun: false }, set: { artifacts: 7 }, artifactsDir: dir }))
        expect(result.applied?.artifacts).toEqual({ dryRun: false, olderThanDays: 7, blobs: 0, bytes: 0 })
        expect(existsSync(dir)).toBe(false)
      }),
    ))
})
