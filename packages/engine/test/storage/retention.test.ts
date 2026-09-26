import { expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"

import { Database } from "@origami/core/database/database"
import { StorageRetention } from "../../src/storage/retention"
import { StorageNestsMeasure } from "../../src/storage/nests-measure"
import { testEffect } from "../lib/effect"

// Fixtures are written as the ROWS the projector writes (core/session/projector.ts
// `partData`: the part minus id/messageID/sessionID), not as invented shapes, so a
// schema change under the prune shows up here rather than in the owner's store.
const DAY = 24 * 60 * 60 * 1000

const truncate = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    for (const table of ["part", "message", "session", "project", "event", "event_sequence"]) {
      yield* db.run(sql`DELETE FROM ${sql.identifier(table)}`)
    }
  }),
)
const truncateNode = LayerNode.make({ name: "truncate-retention", layer: truncate, deps: [Database.node] })

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, truncateNode])))

const toolPart = (options: { output: string; attachments?: boolean; tool?: string; compacted?: boolean }) => ({
  type: "tool",
  callID: "call-1",
  tool: options.tool ?? "read",
  state: {
    status: "completed",
    input: { filePath: "/tmp/a.txt" },
    output: options.output,
    title: "read a.txt",
    metadata: {},
    time: { start: 1, end: 2, ...(options.compacted ? { compacted: 3 } : {}) },
    ...(options.attachments
      ? { attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64," + "A".repeat(2000) }] }
      : {}),
  },
})

const seed = Effect.fnUntraced(function* (input: {
  parts: { id: string; messageID: string; ageDays: number; data: unknown }[]
  messages: { id: string; ageDays: number }[]
}) {
  const { db } = yield* Database.Service
  const now = Date.now()
  yield* db.run(
    sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
        VALUES ('p1', '/tmp/p1', '[]', ${now}, ${now})`,
  )
  yield* db.run(
    sql`INSERT INTO session (id, project_id, slug, directory, title, version, cost,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          time_created, time_updated)
        VALUES ('s1', 'p1', 's1', '/tmp/p1', 'A chat', '0.0.0', 0, 0, 0, 0, 0, 0, ${now}, ${now})`,
  )
  for (const message of input.messages) {
    const at = now - message.ageDays * DAY
    yield* db.run(
      sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES (${message.id}, 's1', ${at}, ${at}, ${JSON.stringify({ role: "assistant" })})`,
    )
  }
  for (const part of input.parts) {
    const at = now - part.ageDays * DAY
    yield* db.run(
      sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES (${part.id}, ${part.messageID}, 's1', ${at}, ${at}, ${JSON.stringify(part.data)})`,
    )
  }
  // The journal, seeded so "the prune never touches it" is an assertion about
  // real rows rather than about an empty table.
  yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('s1', 1)`)
  yield* db.run(
    sql`INSERT INTO event (id, aggregate_id, seq, type, data)
        VALUES ('e1', 's1', 1, 'message.part.updated.1', ${JSON.stringify({ part: { output: "X".repeat(5000) } })})`,
  )
})

const readPart = Effect.fnUntraced(function* (id: string) {
  const { db } = yield* Database.Service
  const row = yield* db
    .get<{ data: string }>(sql`SELECT data FROM part WHERE id = ${id}`)
    .pipe(Effect.orDie)
  return JSON.parse(row!.data) as {
    state: { output: string; time: { compacted?: number }; attachments?: unknown[] }
  }
})

// Old enough to prune, and far enough down the message list to be outside the
// KEEP_RECENT_MESSAGES tail: 25 messages, the oldest carrying the parts.
const manyMessages = Array.from({ length: 25 }, (_, index) => ({
  id: `m${String(index).padStart(2, "0")}`,
  ageDays: 200 - index,
}))

it.live("prune rewrites an old tool part and deletes no row from any table", () =>
  Effect.gen(function* () {
    yield* seed({
      messages: manyMessages,
      parts: [{ id: "prt1", messageID: "m00", ageDays: 200, data: toolPart({ output: "X".repeat(9000) }) }],
    })
    const before = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: true })
    expect(before.parts).toBe(1)
    expect(before.dryRun).toBe(true)
    // A dry run writes nothing.
    expect((yield* readPart("prt1")).state.output.length).toBe(9000)

    const after = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: false })
    expect(after.parts).toBe(1)
    expect(after.bytes).toBeGreaterThan(8000)
    // The three tables the owner's rule protects, counted after the write: a
    // prune that moved any of them is deleting user content, not compacting it.
    expect(after.rows).toEqual({ events: 1, messages: 25, parts: 1 })

    const part = yield* readPart("prt1")
    expect(part.state.output).toBe(StorageRetention.MARKER)
    expect(part.state.time.compacted).toBeGreaterThan(0)
  }),
)

it.live("prune leaves the journal payload and the message rows byte-identical", () =>
  Effect.gen(function* () {
    yield* seed({
      messages: manyMessages,
      parts: [{ id: "prt1", messageID: "m00", ageDays: 200, data: toolPart({ output: "X".repeat(9000) }) }],
    })
    const { db } = yield* Database.Service
    const read = () =>
      Effect.all({
        events: db.all<{ id: string; data: string }>(sql`SELECT id, data FROM event ORDER BY id`),
        messages: db.all<{ id: string; data: string }>(sql`SELECT id, data FROM message ORDER BY id`),
      }).pipe(Effect.orDie)
    const before = yield* read()
    yield* StorageRetention.prune({ olderThanDays: 60, dryRun: false })
    expect(yield* read()).toEqual(before)
  }),
)

it.live("prune drops image attachments and is idempotent on a second pass", () =>
  Effect.gen(function* () {
    yield* seed({
      messages: manyMessages,
      parts: [
        { id: "prt1", messageID: "m00", ageDays: 200, data: toolPart({ output: "X".repeat(50), attachments: true }) },
      ],
    })
    const first = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: false })
    expect(first.parts).toBe(1)
    expect(first.imageBytes).toBeGreaterThan(2000)
    const part = yield* readPart("prt1")
    expect(part.state.attachments).toBeUndefined()

    const second = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: false })
    expect(second.parts).toBe(0)
    expect(second.bytes).toBe(0)
  }),
)

it.live("prune spares the window, the recent tail, and protected tools", () =>
  Effect.gen(function* () {
    yield* seed({
      messages: manyMessages,
      parts: [
        // Inside the window.
        { id: "young", messageID: "m00", ageDays: 5, data: toolPart({ output: "Y".repeat(9000) }) },
        // Old, but its message is in the session's last KEEP_RECENT_MESSAGES.
        { id: "tail", messageID: "m24", ageDays: 200, data: toolPart({ output: "T".repeat(9000) }) },
        // Old and out of the tail, but a skill result a later turn reads back.
        { id: "skill", messageID: "m00", ageDays: 200, data: toolPart({ output: "S".repeat(9000), tool: "skill" }) },
      ],
    })
    const result = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: false })
    expect(result.parts).toBe(0)
    for (const id of ["young", "tail", "skill"]) {
      expect((yield* readPart(id)).state.output.length).toBe(9000)
    }
  }),
)

it.live("a window under the floor is raised to it rather than honoured", () =>
  Effect.gen(function* () {
    yield* seed({
      messages: manyMessages,
      parts: [{ id: "young", messageID: "m00", ageDays: 1, data: toolPart({ output: "Y".repeat(9000) }) }],
    })
    const result = yield* StorageRetention.prune({ olderThanDays: 0, dryRun: false })
    expect(result.olderThanDays).toBe(StorageRetention.MIN_WINDOW_DAYS)
    expect(result.parts).toBe(0)
    expect((yield* readPart("young")).state.output.length).toBe(9000)
  }),
)

// t-vs5krz: the dry run behind the Nests Storage card was ONE statement over
// every part row. bun:sqlite is synchronous, so on the owner-size store copy the
// engine stood still for 1.6-2.5 s: no chat streamed and no call was answered.
// It now reads in rowid ranges and rests between them. A macrotask chain counts
// the loop turns the dry run leaves: one statement leaves none.
it.live("the dry run gives the event loop turns while it reads", () =>
  Effect.gen(function* () {
    yield* seed({
      messages: manyMessages,
      parts: Array.from({ length: 6 }, (_, index) => ({
        id: `prt${index}`,
        messageID: "m00",
        ageDays: 200,
        data: toolPart({ output: "X".repeat(900) }),
      })),
    })
    let turns = 0
    let spinning = true
    const spin = () => {
      turns++
      if (spinning) setImmediate(spin)
    }
    setImmediate(spin)
    const result = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: true, sliceRows: 1 })
    spinning = false
    expect(result.parts).toBe(6)
    // One range per part row, and at least one turn after each range.
    expect(turns).toBeGreaterThanOrEqual(6)
  }),
)

// t-vs5krz: one tool part of 118 MB on the owner's store (an image in its
// attachments) took 175-250 ms to parse, in one call. The dry run now uses the
// measure's rule for a row above HUGE_BYTES: old + `{"type":"tool"` prefix =
// a candidate, and its bytes count whole as images, with no parse. The row is
// built inside SQLite, so the test process never holds it as a string.
it.live("a tool part over the huge bound is counted whole, without holding the event loop", () =>
  Effect.gen(function* () {
    yield* seed({ messages: manyMessages, parts: [] })
    const { db } = yield* Database.Service
    const at = Date.now() - 200 * DAY
    const head = JSON.stringify(toolPart({ output: "x" })).replace(/\}\}$/, "")
    yield* db.run(
      sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES ('huge', 'm00', 's1', ${at}, ${at},
            ${head + ',"attachments":[{"type":"file","mime":"image/png","url":"data:image/png;base64,'}
              || replace(hex(zeroblob(150000000)), '0', 'A') || '"}]}}')`,
    )
    const row = yield* db
      .get<{ n: number; valid: number }>(sql`SELECT octet_length(data) AS n, json_valid(data) AS valid FROM part WHERE id = 'huge'`)
      .pipe(Effect.orDie)
    expect(row!.valid).toBe(1)
    expect(row!.n).toBeGreaterThan(StorageNestsMeasure.HUGE_BYTES)

    let gap = 0
    let last = performance.now()
    let spinning = true
    const spin = () => {
      const now = performance.now()
      gap = Math.max(gap, now - last)
      last = now
      if (spinning) setImmediate(spin)
    }
    setImmediate(spin)
    const result = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: true })
    spinning = false
    expect(gap).toBeLessThan(250)
    expect(result.parts).toBe(1)
    expect(result.imageBytes).toBe(row!.n)
    expect(result.toolOutputBytes).toBe(0)
  }),
)

// One part of every kind the candidate rule looks at, in two sessions, with
// two-byte characters (the sums are `length()`: characters, not bytes).
const seedEveryKind = Effect.fnUntraced(function* () {
    const old = (id: string, messageID: string, data: unknown) => ({ id, messageID, ageDays: 200, data })
    // 40 messages: m00-m19 are out of the tail, m20-m39 are the tail.
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: `m${String(index).padStart(2, "0")}`,
      ageDays: 200 - index,
    }))
    yield* seed({
      messages,
      parts: [
        old("plain", "m00", toolPart({ output: "X".repeat(900) })),
        old("wide", "m01", toolPart({ output: String.fromCharCode(0xe9).repeat(300) })),
        old("image", "m02", toolPart({ output: "Y".repeat(40), attachments: true })),
        old("skill", "m03", toolPart({ output: "S".repeat(500), tool: "skill" })),
        old("marked", "m04", toolPart({ output: StorageRetention.MARKER })),
        old("markedImage", "m05", toolPart({ output: StorageRetention.MARKER, attachments: true })),
        old("empty", "m06", toolPart({ output: "" })),
        old("running", "m07", { ...toolPart({ output: "R".repeat(700) }), state: { status: "running", input: {} } }),
        old("text", "m08", { type: "text", text: "T".repeat(800) }),
        old("tail", "m39", toolPart({ output: "Z".repeat(600) })),
        { id: "young", messageID: "m09", ageDays: 5, data: toolPart({ output: "N".repeat(600) }) },
      ],
    })
    // A second session: the tail is per session, so its one old message is
    // in its own tail and keeps its part.
    const { db } = yield* Database.Service
    const now = Date.now()
    yield* db.run(
      sql`INSERT INTO session (id, project_id, slug, directory, title, version, cost,
            tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
            time_created, time_updated)
          VALUES ('s2', 'p1', 's2', '/tmp/p1', 'Other chat', '0.0.0', 0, 0, 0, 0, 0, 0, ${now}, ${now})`,
    )
    yield* db.run(
      sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('n00', 's2', ${now - 300 * DAY}, ${now - 300 * DAY}, '{"role":"assistant"}')`,
    )
    yield* db.run(
      sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES ('s2part', 'n00', 's2', ${now - 300 * DAY}, ${now - 300 * DAY}, ${JSON.stringify(toolPart({ output: "Q".repeat(700) }))})`,
    )
})

const sums = (result: StorageRetention.PruneResult) => ({
  parts: result.parts,
  toolOutputBytes: result.toolOutputBytes,
  imageBytes: result.imageBytes,
  bytes: result.bytes,
})

// The ranged dry run must count what the write path counts: the number a user
// confirms on the card is the number the Apply writes.
it.live("the dry run in ranges counts exactly what the write counts", () =>
  Effect.gen(function* () {
    yield* seedEveryKind()
    const oneRowRanges = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: true, sliceRows: 1 })
    const smallRanges = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: true, sliceRows: 3, sliceBytes: 700 })
    const defaultRanges = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: true })
    const written = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: false })
    // plain, wide, image and markedImage: 4 parts. Output 900 + 300 + 40 + the
    // marker's own characters, less one marker per part (what the write leaves).
    expect(sums(written)).toMatchObject({ parts: 4, toolOutputBytes: 1240 - 3 * StorageRetention.MARKER.length })
    expect(written.imageBytes).toBeGreaterThan(4000)
    expect(sums(oneRowRanges)).toEqual(sums(written))
    expect(sums(smallRanges)).toEqual(sums(written))
    expect(sums(defaultRanges)).toEqual(sums(written))
    expect(oneRowRanges.rows).toEqual(written.rows)
  }),
)

// t-vs5krz: the Apply was one SELECT and one UPDATE over the whole part table:
// one 4.0 s block of the event loop on the owner-size store copy. It now
// writes in rowid ranges, one transaction each, with loop turns between them.
it.live("the Apply gives the event loop turns while it writes", () =>
  Effect.gen(function* () {
    yield* seed({
      messages: manyMessages,
      parts: Array.from({ length: 6 }, (_, index) => ({
        id: `prt${index}`,
        messageID: "m00",
        ageDays: 200,
        data: toolPart({ output: "X".repeat(900) }),
      })),
    })
    let turns = 0
    let spinning = true
    const spin = () => {
      turns++
      if (spinning) setImmediate(spin)
    }
    setImmediate(spin)
    const result = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: false, sliceRows: 1 })
    spinning = false
    expect(result.parts).toBe(6)
    expect(turns).toBeGreaterThanOrEqual(6)
    expect((yield* readPart("prt5")).state.output).toBe(StorageRetention.MARKER)
  }),
)

// A row above the huge bound is not parsed to find the Apply's candidates, so
// its UPDATE checks the full rule: a huge old tool part that is still running
// (or a skill result) must keep its payload, as the single statement kept it.
// The huge bound is lowered for the test (the >32 MB row is covered above).
it.live("the Apply rewrites a huge part only when the full rule admits it", () =>
  Effect.gen(function* () {
    const big = "B".repeat(3000)
    yield* seed({
      messages: manyMessages,
      parts: [
        { id: "hugeDone", messageID: "m00", ageDays: 200, data: toolPart({ output: big }) },
        { id: "hugeSkill", messageID: "m01", ageDays: 200, data: toolPart({ output: big, tool: "skill" }) },
        {
          id: "hugeRunning",
          messageID: "m02",
          ageDays: 200,
          data: { ...toolPart({ output: big }), state: { status: "running", input: {}, output: big } },
        },
        { id: "hugeTail", messageID: "m24", ageDays: 200, data: toolPart({ output: big }) },
        { id: "small", messageID: "m03", ageDays: 200, data: toolPart({ output: "S".repeat(100) }) },
      ],
    })
    const { db } = yield* Database.Service
    const done = yield* db
      .get<{ n: number }>(sql`SELECT octet_length(data) AS n FROM part WHERE id = 'hugeDone'`)
      .pipe(Effect.orDie)
    const result = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: false, hugeBytes: 2000 })
    expect(result.parts).toBe(2)
    expect(result.imageBytes).toBe(done!.n)
    expect(result.toolOutputBytes).toBe(100 - StorageRetention.MARKER.length)
    expect((yield* readPart("hugeDone")).state.output).toBe(StorageRetention.MARKER)
    expect((yield* readPart("small")).state.output).toBe(StorageRetention.MARKER)
    for (const id of ["hugeSkill", "hugeRunning", "hugeTail"]) expect((yield* readPart(id)).state.output).toBe(big)
  }),
)

// The Apply in ranges must write what the single statement wrote. The oracle
// is that statement pair as it was on master f9d49f6b70, run in a transaction
// that is rolled back; then the ranged Apply runs on the same rows, one row per
// range (the tail is read per range, for the sessions of the range).
it.live("the Apply in ranges writes exactly what the single statement wrote", () =>
  Effect.gen(function* () {
    yield* seedEveryKind()
    const { db } = yield* Database.Service
    const cutoff = Date.now() - 60 * DAY
    const rule = sql`part.time_created < ${cutoff}
      AND json_extract(part.data, '$.type') = 'tool'
      AND json_extract(part.data, '$.state.status') = 'completed'
      AND coalesce(json_extract(part.data, '$.tool'), '') NOT IN ('skill')
      AND (
        coalesce(json_extract(part.data, '$.state.output'), '') NOT IN ('', ${StorageRetention.MARKER})
        OR json_extract(part.data, '$.state.attachments') IS NOT NULL
      )
      AND part.message_id NOT IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (
            PARTITION BY session_id ORDER BY time_created DESC, id DESC
          ) AS rn FROM message
        ) WHERE rn <= ${StorageRetention.KEEP_RECENT_MESSAGES}
      )`
    // The compaction time is the clock of each run: compared as "set".
    const rows = () =>
      db
        .all<{ id: string; data: string }>(
          sql`SELECT id, CASE WHEN json_extract(data, '$.state.time.compacted') IS NULL THEN data
              ELSE json_set(data, '$.state.time.compacted', 1) END AS data FROM part ORDER BY id`,
        )
        .pipe(Effect.orDie)
    const before = yield* rows()
    yield* db.run(sql`BEGIN`).pipe(Effect.orDie)
    const whole = yield* db
      .get<{ n: number; out: number; img: number }>(
        sql`SELECT count(*) AS n,
          sum(length(coalesce(json_extract(part.data, '$.state.output'), ''))) AS out,
          sum(length(coalesce(json_extract(part.data, '$.state.attachments'), ''))) AS img
          FROM part WHERE ${rule}`,
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`UPDATE part SET data = json_set(json_remove(data, '$.state.attachments'),
          '$.state.output', ${StorageRetention.MARKER}, '$.state.time.compacted', 7) WHERE ${rule}`,
      )
      .pipe(Effect.orDie)
    const expected = yield* rows()
    yield* db.run(sql`ROLLBACK`).pipe(Effect.orDie)
    expect(yield* rows()).toEqual(before)

    const written = yield* StorageRetention.prune({ olderThanDays: 60, dryRun: false, sliceRows: 1 })
    expect(yield* rows()).toEqual(expected)
    expect(expected).not.toEqual(before)
    expect(sums(written)).toEqual({
      parts: whole!.n,
      toolOutputBytes: Math.max(0, whole!.out - whole!.n * StorageRetention.MARKER.length),
      imageBytes: whole!.img,
      bytes: Math.max(0, whole!.out - whole!.n * StorageRetention.MARKER.length) + whole!.img,
    })
    expect(written.parts).toBe(4)
  }),
)

it.live("stats splits the store into journal, messages and the part classes", () =>
  Effect.gen(function* () {
    yield* seed({
      messages: manyMessages,
      parts: [
        { id: "prt1", messageID: "m00", ageDays: 200, data: toolPart({ output: "X".repeat(9000) }) },
        {
          id: "img",
          messageID: "m00",
          ageDays: 200,
          data: { type: "file", mime: "image/png", url: "data:image/png;base64," + "B".repeat(4000) },
        },
      ],
    })
    const result = yield* StorageRetention.stats()
    expect(result.counts).toEqual({ events: 1, messages: 25, parts: 2, sessions: 1 })
    expect(result.journalBytes).toBeGreaterThan(5000)
    expect(result.parts.toolOutput).toBe(9000)
    expect(result.parts.images).toBeGreaterThan(4000)
    expect(result.fileBytes).toBeGreaterThan(0)
    expect(result.method).toBe("length-sums")
  }),
)
