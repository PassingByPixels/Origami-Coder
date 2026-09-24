// t-tc2193. Several engines (one per window) on one store file. Another
// engine waits for this one's write lock up to its busy_timeout (5 s) and then
// fails its event write, so the long holders are tested against a SEPARATE
// process:
//
// - `StorageNests.exportChunk` holds the lock (BEGIN IMMEDIATE) for its
//   compaction, claim, read and mark. A writer process runs while this process
//   exports a large session: no write fails and none waits 5 s.
// - `StorageJournal.vacuum` holds the store for minutes. It runs only when no
//   other process has the file open, and refuses `in-use` otherwise.

import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@origami/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { StorageJournal } from "../../src/storage/journal"
import { StorageNests } from "../../src/storage/nests"
import { DESK_A, type Store, nextDir, on, storeLayer } from "./nests-fixture"

const SESSION = "ses_nests_large"
// 9,000 rows and about 54 MB per fill: 600 parts, each rewritten 15 times as
// it streams, the text growing to 12,000 characters. At this size the old
// compaction (one DELETE per group, each reading its group's whole range) held
// the lock for about 6 s and the writer below failed; the one-DELETE-per-family
// pass holds it for about 0.5 s (measured 2026-09-23, this machine).
const PARTS = 600
const REWRITES = 15
const TEXT = 12_000
const CHUNK = 24_000 // the host's NEST_CHUNK_BYTES

/** Append one streamed turn's worth of part rewrites, straight into the
 *  journal: the rows are what the export and the compaction read. */
const fill = Effect.fnUntraced(function* (tag: string) {
  const { db } = yield* Database.Service
  const run = (query: ReturnType<typeof sql>) => db.run(query).pipe(Effect.orDie)
  yield* run(sql`INSERT OR IGNORE INTO ${sql.identifier("event_sequence")} (aggregate_id, seq) VALUES (${SESSION}, -1)`)
  const start = (yield* db
    .get<{ seq: number }>(sql`SELECT seq FROM ${sql.identifier("event_sequence")} WHERE aggregate_id = ${SESSION}`)
    .pipe(Effect.orDie))!.seq + 1
  yield* run(sql`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${PARTS * REWRITES - 1})
    INSERT INTO ${sql.identifier("event")} (id, aggregate_id, seq, type, data)
    SELECT 'evt_' || ${tag} || '_' || i, ${SESSION}, ${start} + i, 'message.part.updated.1',
      json_object('sessionID', ${SESSION}, 'time', i, 'part', json_object(
        'id', 'prt_' || ${tag} || '_' || (i % ${PARTS}), 'messageID', 'msg_large', 'sessionID', ${SESSION},
        'type', 'text', 'text', substr(${"x".repeat(TEXT)}, 1, 1 + (i / ${PARTS}) * ${TEXT / REWRITES})))
    FROM n`)
  yield* run(sql`UPDATE ${sql.identifier("event_sequence")}
    SET seq = (SELECT max(seq) FROM ${sql.identifier("event")} WHERE aggregate_id = ${SESSION})
    WHERE aggregate_id = ${SESSION}`)
})

/** A writer in another process: one INSERT every 5 ms with the engine's
 *  busy_timeout, until `stop` exists. Reports when each write started, how long
 *  it waited, and any error. */
const WRITER = `
const { Database } = require("bun:sqlite")
const { existsSync } = require("node:fs")
const db = new Database(process.env.STORE)
db.run("PRAGMA busy_timeout = 5000")
console.log("ready")
const writes = []
const errors = []
while (!existsSync(process.env.STOP)) {
  const at = Date.now()
  const t0 = performance.now()
  try { db.run("INSERT INTO probe_write (t) VALUES (?)", [at]) } catch (e) { errors.push(String(e)) }
  writes.push({ at, wait: performance.now() - t0 })
  Bun.sleepSync(5)
}
console.log(JSON.stringify({ writes, errors }))
`

describe("export against a writer in another engine (t-tc2193)", () => {
  test("a large session's exports never make another process's write wait 5 s", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const a = (yield* Layer.build(storeLayer())) as Store
          yield* on(a, fill("first"))
          const { db } = yield* on(a, Database.Service)
          const file = (yield* db
            .get<{ file: string }>(sql`SELECT file FROM pragma_database_list WHERE name = 'main'`)
            .pipe(Effect.orDie))!.file
          yield* db.run(sql`CREATE TABLE probe_write (t INTEGER)`).pipe(Effect.orDie)
          const stop = nextDir("writer-stop")
          const writer = spawn(process.execPath, ["-e", WRITER], {
            env: { ...process.env, STORE: file, STOP: stop },
            stdio: ["ignore", "pipe", "pipe"],
          })
          let out = ""
          writer.stdout.on("data", (data) => (out += data))
          writer.stderr.on("data", (data) => (out += data))
          const exited = new Promise<void>((resolve) => writer.on("close", () => resolve()))
          yield* Effect.promise(async () => {
            while (!out.includes("ready")) await Bun.sleep(20)
          })

          const windows: Array<{ from: number; to: number }> = []
          const timed = <A, E>(effect: Effect.Effect<A, E, Database.Service | EventV2Bridge.Service>) =>
            Effect.gen(function* () {
              const from = Date.now()
              const result = yield* on(a, effect)
              windows.push({ from, to: Date.now() })
              // A gap, as between two chunk requests, so the writer is not
              // measured against back-to-back locks this test makes up.
              yield* Effect.sleep("50 millis")
              return result
            })
          const exportAt = (after: number) =>
            StorageNests.exportChunk({ deviceId: DESK_A, sessionId: SESSION, after, maxBytes: CHUNK })
          // The first export compacts 9,000 rows and claims; the tail pass after
          // another 9,000 compacts only past the mark; the last is a plain read.
          const first = yield* timed(exportAt(-1))
          if ("refused" in first) throw new Error("refused")
          yield* on(a, fill("tail"))
          const tail = yield* timed(exportAt(first.to))
          if ("refused" in tail) throw new Error("refused")
          yield* timed(exportAt(tail.to))

          writeFileSync(stop, "")
          yield* Effect.promise(() => exited)
          const report = JSON.parse(out.trim().split("\n").at(-1)!) as {
            writes: Array<{ at: number; wait: number }>
            errors: string[]
          }
          const contended = report.writes.filter((write) =>
            windows.some((window) => write.at >= window.from && write.at < window.to),
          )
          const longest = Math.max(...report.writes.map((write) => write.wait))
          console.log(
            `export hold (ms): ${windows.map((window) => window.to - window.from).join(", ")}; ` +
              `writer: ${report.writes.length} writes, ${contended.length} during an export, longest wait ${Math.round(longest)} ms`,
          )
          expect(report.errors).toEqual([])
          // The writer really ran against the exports' lock...
          expect(contended.length).toBeGreaterThan(0)
          // ...and no write came near the point where it would have failed.
          expect(longest).toBeLessThan(5_000)
        }),
      ),
    ), 60_000)
})

/** Another engine: a process that opens the store, reads it once and keeps
 *  it open until `stop` exists. */
const HOLDER = `
const { Database } = require("bun:sqlite")
const { existsSync } = require("node:fs")
const db = new Database(process.env.STORE)
db.run("PRAGMA busy_timeout = 5000")
db.query("SELECT count(*) FROM sqlite_master").get()
console.log("ready")
while (!existsSync(process.env.STOP)) Bun.sleepSync(20)
db.close()
`

/** One INSERT from a fresh process with a short busy_timeout: "ok", or the
 *  error, e.g. when this process still holds an exclusive lock. */
const writeFrom = (file: string) => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `const { Database } = require("bun:sqlite")
       const db = new Database(process.env.STORE)
       db.run("PRAGMA busy_timeout = 300")
       try { db.run("CREATE TABLE IF NOT EXISTS probe_write (t INTEGER)"); db.run("INSERT INTO probe_write (t) VALUES (1)"); console.log("ok") }
       catch (e) { console.log(String(e)) }`,
    ],
    { env: { ...process.env, STORE: file } },
  )
  return result.stdout.toString().trim()
}

const storeFile = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  return (yield* db
    .get<{ file: string }>(sql`SELECT file FROM pragma_database_list WHERE name = 'main'`)
    .pipe(Effect.orDie))!.file
})

describe("vacuum with other engines on the store (t-tc2193)", () => {
  test("refuses in-use while another process has the store open, and leaves it writable", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const a = (yield* Layer.build(storeLayer())) as Store
          const file = yield* on(a, storeFile())
          const stop = nextDir("holder-stop")
          const holder = spawn(process.execPath, ["-e", HOLDER], {
            env: { ...process.env, STORE: file, STOP: stop },
            stdio: ["ignore", "pipe", "pipe"],
          })
          let out = ""
          holder.stdout.on("data", (data) => (out += data))
          holder.stderr.on("data", (data) => (out += data))
          const exited = new Promise<void>((resolve) => holder.on("close", () => resolve()))
          yield* Effect.promise(async () => {
            while (!out.includes("ready")) await Bun.sleep(20)
          })
          const result = yield* on(a, StorageJournal.vacuum({ confirm: true }))
          writeFileSync(stop, "")
          yield* Effect.promise(() => exited)
          expect(result.ran).toBe(false)
          // The free-space check comes first; on a machine short of space that
          // is the answer instead.
          expect(result.refused).toBe(result.freeBytes >= result.requiredBytes ? "in-use" : "free-space")
          // The refused attempt left no lock behind.
          expect(writeFrom(file)).toBe("ok")
        }),
      ),
    ), 60_000)

  test("runs when no other process has the store open, then releases it", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const a = (yield* Layer.build(storeLayer())) as Store
          const file = yield* on(a, storeFile())
          const result = yield* on(a, StorageJournal.vacuum({ confirm: true }))
          expect(result.ran).toBe(result.freeBytes >= result.requiredBytes)
          // After the VACUUM another engine can write again.
          expect(writeFrom(file)).toBe("ok")
        }),
      ),
    ), 60_000)
})
