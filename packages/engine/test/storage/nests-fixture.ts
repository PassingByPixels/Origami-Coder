// The two-store harness of the Nests store tests (L4a t-s9jgzh, moved here
// unchanged by L5 t-sb9tlk so the hand-over tests share it). Two real SQLite
// files, each with its own event service and projectors, so nothing on B can
// come from A except through the chunks.

import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Database } from "@origami/core/database/database"
import { EventV2 } from "@origami/core/event"
import { SessionProjector } from "@origami/core/session/projector"
import { SessionV1 } from "@origami/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { StorageNests } from "../../src/storage/nests"

// Under the preload's per-process data dir, which the preload removes (with the
// Windows WAL-handle retry) after the run.
export const root = mkdtempSync(path.join(process.env["XDG_DATA_HOME"] ?? os.tmpdir(), "nests-test-"))

let counter = 0
export const storeLayer = () =>
  LayerNode.compile(LayerNode.group([Database.node, EventV2.node, EventV2Bridge.node, SessionProjector.node]), [
    [Database.node, Database.layerFromPath(path.join(root, `store-${++counter}.db`))],
  ])

export type Store = Context.Context<Database.Service | EventV2Bridge.Service>

/** Two fresh stores, A and B, for one test. */
export const withStores = <A>(body: (a: Store, b: Store) => Effect.Effect<A, unknown, never>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const a = (yield* Layer.build(storeLayer())) as Store
        const b = (yield* Layer.build(storeLayer())) as Store
        return yield* body(a, b)
      }),
    ),
  )

export const on = <A, E>(store: Store, effect: Effect.Effect<A, E, Database.Service | EventV2Bridge.Service>) =>
  effect.pipe(Effect.provide(store))

export const DESK_A = "deskAAAAAAA"
export const DESK_B = "deskBBBBBBB"
export const DESK_C = "deskCCCCCCC"
export const SESSION = SessionID.make("ses_nests_test")
export const CHILD = SessionID.make("ses_nests_child")
export const MESSAGE = MessageID.make("msg_nests_test")
export const PARENT = MessageID.make("msg_nests_parent")

export const info = (overrides: Partial<SessionV1.SessionInfo> = {}) =>
  ({
    id: SESSION,
    slug: "nests",
    projectID: "prj_nests",
    directory: "/tmp/nests",
    title: "A chat",
    version: "0.0.0",
    cost: 0,
    time: { created: 1_000, updated: 1_000 },
    ...overrides,
  }) as SessionV1.SessionInfo

export const assistant = (overrides: Partial<SessionV1.Assistant> = {}) =>
  ({
    id: MESSAGE,
    sessionID: SESSION,
    role: "assistant",
    parentID: PARENT,
    modelID: "m",
    providerID: "p",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp/nests", root: "/tmp/nests" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 5_000, completed: 6_000 },
    ...overrides,
  }) as SessionV1.Assistant

export const part = (id: string, fields: Record<string, unknown>) =>
  ({ id: PartID.make(id), messageID: MESSAGE, sessionID: SESSION, ...fields }) as SessionV1.Part

/** A chat the way the writer produces one: parts rewritten as they stream, a
 *  tool part with output, a step-finish part whose cost accumulates on the
 *  session row, and a retitle. */
export const write = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  yield* db
    .run(
      sql`INSERT INTO ${sql.identifier("project")} (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('prj_nests', '/tmp/nests', '[]', 1000, 1000)`,
    )
    .pipe(Effect.orDie)
  yield* events.publish(SessionV1.Event.Created, { sessionID: SESSION, info: info() })
  yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: SESSION, info: assistant() })
  for (const [index, text] of ["He", "Hell", "Hello ther", "Hello there, a longer answer"].entries())
    yield* events.publish(SessionV1.Event.PartUpdated, {
      sessionID: SESSION,
      part: part("prt_a", { type: "text", text, time: { start: 1_000 } }),
      time: 1_100 + index,
    })
  yield* events.publish(SessionV1.Event.PartUpdated, {
    sessionID: SESSION,
    part: part("prt_tool", {
      type: "tool",
      tool: "read",
      callID: "call_1",
      state: {
        status: "completed",
        input: { path: "a.ts" },
        output: "x".repeat(400),
        title: "a.ts",
        metadata: {},
        time: { start: 1_150, end: 1_160 },
      },
    }),
    time: 1_150,
  })
  yield* events.publish(SessionV1.Event.Updated, { sessionID: SESSION, info: info({ title: "Renamed" }) })
  yield* events.publish(SessionV1.Event.PartUpdated, {
    sessionID: SESSION,
    part: part("prt_step", {
      type: "step-finish",
      reason: "stop",
      cost: 0.25,
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    time: 1_300,
  })
  yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: SESSION, info: assistant({ cost: 0.25 }) })
  yield* events.publish(SessionV1.Event.Updated, { sessionID: SESSION, info: info({ title: "Renamed twice" }) })
})

/** Every column of the three projected tables, as SQLite stores them. */
export const rows = Effect.fnUntraced(function* (sessionID?: string) {
  const { db } = yield* Database.Service
  const out: Record<string, unknown[]> = {}
  for (const table of ["session", "message", "part"]) {
    // One session's rows when `sessionID` is given (L5: a store may also hold a fork).
    const where = sessionID
      ? sql`WHERE ${sql.identifier(table === "session" ? "id" : "session_id")} = ${sessionID}`
      : sql``
    out[table] = yield* db
      .all<Record<string, unknown>>(sql`SELECT * FROM ${sql.identifier(table)} ${where} ORDER BY id`)
      .pipe(Effect.orDie)
  }
  return out
})

export const journal = Effect.fnUntraced(function* (sessionID: string = SESSION) {
  const { db } = yield* Database.Service
  return yield* db
    .all<{
      id: string
      seq: number
      type: string
      data: string
    }>(sql`SELECT id, seq, type, data FROM ${sql.identifier("event")} WHERE aggregate_id = ${sessionID} ORDER BY seq`)
    .pipe(Effect.orDie)
})

export const ownerOf = Effect.fnUntraced(function* (sessionID: string = SESSION) {
  const { db } = yield* Database.Service
  return (yield* db
    .get<{
      owner_id: string | null
    }>(sql`SELECT owner_id FROM ${sql.identifier("event_sequence")} WHERE aggregate_id = ${sessionID}`)
    .pipe(Effect.orDie))?.owner_id
})

/** Every chunk of the session from `deviceId` (desk A), from `start + 1`, as the host would pull them. */
export const exportAll = Effect.fnUntraced(function* (maxBytes: number, deviceId: string = DESK_A, start = -1) {
  const chunks: StorageNests.Chunk[] = []
  let after = start
  while (true) {
    const chunk = yield* StorageNests.exportChunk({ deviceId, sessionId: SESSION, after, maxBytes })
    if ("refused" in chunk) throw new Error(`export refused: ${chunk.refused}`)
    if (chunk.events.length > 0) chunks.push(chunk)
    if (chunk.done) return chunks
    after = chunk.to
  }
})

/**
 * The rows with the two things a replay cannot reproduce taken out, and nothing
 * else: `time_updated` on message and part rows is `Date.now()` at the write
 * (`Timestamps.$onUpdate`), and `data` on those rows is the JSON of the payload
 * in the order the writer built it, while a replay decodes it through the schema
 * first and so writes the keys in schema order. `data` is therefore compared as
 * the JSON VALUE it holds. The session row keeps every column: its times come
 * from the payload.
 */
export const state = (tables: Record<string, unknown[]>) =>
  Object.fromEntries(
    Object.entries(tables).map(([table, list]) => [
      table,
      table === "session"
        ? list
        : (list as Record<string, unknown>[]).map(({ time_updated: _, data, ...row }) => ({
            ...row,
            data: JSON.parse(data as string) as unknown,
          })),
    ]),
  )

/** The same rows, minus only the write clock: for two REPLAYS, whose `data`
 *  text must match byte for byte. */
export const bytes = (tables: Record<string, unknown[]>) =>
  Object.fromEntries(
    Object.entries(tables).map(([table, list]) => [
      table,
      table === "session" ? list : (list as Record<string, unknown>[]).map(({ time_updated: _, ...row }) => row),
    ]),
  )

/** A chunk as it crosses the wire: JSON, so nothing is shared by reference. */
export const wire = (chunk: StorageNests.Chunk) => JSON.parse(JSON.stringify(chunk)) as unknown

/** A fresh directory under the per-process data dir. */
export const nextDir = (name: string) => path.join(root, `${name}-${++counter}`)
