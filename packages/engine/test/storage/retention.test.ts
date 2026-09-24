import { expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"

import { Database } from "@origami/core/database/database"
import { StorageRetention } from "../../src/storage/retention"
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
