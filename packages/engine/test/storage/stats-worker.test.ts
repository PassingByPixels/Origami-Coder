import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Database } from "@origami/core/database/database"
import { StorageRetention } from "../../src/storage/retention"
import { StorageRead } from "../../src/storage/read-runner"

// t-w2r1kf: `storage_stats` and the prune's row counts run on a Worker with its
// own read-only connection, so the engine's event loop is not held for the
// whole-table scans. The numbers must be the ones the engine's own connection
// gives, and every failure of the Worker must end in the inline run.

const root = mkdtempSync(path.join(process.env["XDG_DATA_HOME"] ?? os.tmpdir(), "stats-worker-"))
let counter = 0
const fileStore = () =>
  LayerNode.compile(LayerNode.group([Database.node]), [
    [Database.node, Database.layerFromPath(path.join(root, `store-${++counter}.db`))],
  ])

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>, layer: Layer.Layer<Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<A, E, never>)

afterEach(() => {
  StorageRead.testing.reset()
  delete process.env.ORIGAMI_STORAGE_WORKER
})

const DAY = 24 * 60 * 60 * 1000

// Rows as the projector writes them, with non-ASCII text so `length()` (a
// character count) and a byte count would differ.
const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const now = Date.now()
  yield* db.run(
    sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('p1', '/tmp/p1', '[]', ${now}, ${now})`,
  )
  yield* db.run(
    sql`INSERT INTO session (id, project_id, slug, directory, title, version, cost,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          time_created, time_updated)
        VALUES ('s1', 'p1', 's1', '/tmp/p1', 'A chat', '0.0.0', 0, 0, 0, 0, 0, 0, ${now}, ${now})`,
  )
  for (let i = 0; i < 30; i++) {
    const at = now - (200 - i) * DAY
    yield* db.run(
      sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES (${`m${String(i).padStart(2, "0")}`}, 's1', ${at}, ${at}, ${JSON.stringify({ role: "assistant", text: "é".repeat(i) })})`,
    )
  }
  const parts = [
    { type: "tool", tool: "read", state: { status: "completed", output: "ü".repeat(900), time: { start: 1, end: 2 } } },
    {
      type: "tool",
      tool: "read",
      state: { status: "completed", output: "x", attachments: [{ url: "data:," + "A".repeat(700) }], time: {} },
    },
    { type: "file", mime: "image/png", url: "data:image/png;base64," + "B".repeat(400) },
    { type: "text", text: "plain ✓" },
  ]
  for (const [i, data] of parts.entries()) {
    const at = now - 200 * DAY
    yield* db.run(
      sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES (${`prt${i}`}, 'm00', 's1', ${at}, ${at}, ${JSON.stringify(data)})`,
    )
  }
  yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('s1', 1)`)
  yield* db.run(
    sql`INSERT INTO event (id, aggregate_id, seq, type, data)
        VALUES ('e1', 's1', 1, 'message.part.updated.1', ${JSON.stringify({ part: { output: "ß".repeat(500) } })})`,
  )
})

const withoutTime = ({ measuredMs: _, ...rest }: StorageRetention.Stats) => rest

test("stats on the Worker equal the inline stats of the same store", async () => {
  const layer = fileStore()
  const [onWorker, inline] = await run(
    Effect.gen(function* () {
      yield* seed
      const onWorker = yield* StorageRetention.stats()
      process.env.ORIGAMI_STORAGE_WORKER = "0"
      const inline = yield* StorageRetention.stats()
      return [onWorker, inline] as const
    }),
    layer,
  )
  expect(StorageRead.testing.counts()).toEqual({ worker: 1, inline: 1 })
  expect(onWorker.counts).toEqual({ events: 1, messages: 30, parts: 4, sessions: 1 })
  expect(onWorker.parts.toolOutput).toBe(901)
  expect(onWorker.journalBytes).toBeGreaterThan(500)
  expect(withoutTime(onWorker)).toEqual(withoutTime(inline))
})

test("prune row counts come from the Worker and see the rewrite just committed", async () => {
  const layer = fileStore()
  const result = await run(
    Effect.gen(function* () {
      yield* seed
      return yield* StorageRetention.prune({ olderThanDays: 60, dryRun: false })
    }),
    layer,
  )
  expect(result.parts).toBe(2)
  expect(result.rows).toEqual({ events: 1, messages: 30, parts: 4 })
  expect(StorageRead.testing.counts().worker).toBe(1)
})

test("falls back to inline when the Worker cannot load or fails", async () => {
  const layer = fileStore()
  const dying = path.join(root, "dying-worker.ts")
  writeFileSync(dying, `self.onmessage = () => { throw new Error("worker died") }\n`)
  const [expected, missing, died] = await run(
    Effect.gen(function* () {
      yield* seed
      process.env.ORIGAMI_STORAGE_WORKER = "0"
      const expected = yield* StorageRetention.stats()
      delete process.env.ORIGAMI_STORAGE_WORKER
      StorageRead.testing.setWorkerUrl(path.join(root, "does-not-exist-worker.ts"))
      const missing = yield* StorageRetention.stats()
      StorageRead.testing.setWorkerUrl(dying)
      const died = yield* StorageRetention.stats()
      return [expected, missing, died] as const
    }),
    layer,
  )
  expect(withoutTime(missing)).toEqual(withoutTime(expected))
  expect(withoutTime(died)).toEqual(withoutTime(expected))
  expect(StorageRead.testing.counts()).toEqual({ worker: 0, inline: 3 })
})
