// t-ucnjwp (lazy loading L4): the two in-process store reads of the bounded
// restore, against a real (test) store. Rows are inserted with the columns the
// session migrations create, as `test/storage/retention.test.ts` does.
import { expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@origami/core/database/database"
import { ACPHistoryStore } from "../../src/acp/history-store"
import { testEffect } from "../lib/effect"

const truncate = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    for (const table of ["part", "message", "session", "project"]) {
      yield* db.run(sql`DELETE FROM ${sql.identifier(table)}`)
    }
  }),
)
const truncateNode = LayerNode.make({ name: "truncate-history-store", layer: truncate, deps: [Database.node] })
const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, truncateNode])))

const session = Effect.fnUntraced(function* (id: string, parent: string | null, created: number, tokens = 0) {
  const { db } = yield* Database.Service
  yield* db.run(
    sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, agent, version, cost,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          time_created, time_updated)
        VALUES (${id}, 'p1', ${parent}, ${id}, '/tmp/p1', ${`title ${id}`}, 'explore', '0.0.0', ${tokens / 1000},
          ${tokens}, ${tokens / 10}, 0, ${tokens * 2}, 0, ${created}, ${created})`,
  )
})

const seed = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('p1', '/tmp/p1', '[]', 1, 1)`)
  yield* session("root", null, 1)
  yield* session("child_b", "root", 30, 500)
  yield* session("child_a", "root", 20, 100)
  yield* session("grandchild", "child_a", 25, 7)
  yield* session("other_root", null, 2)
  yield* session("other_child", "other_root", 3, 9)
  for (let index = 0; index < 7; index++) {
    yield* db.run(
      sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES (${`m${index}`}, 'root', ${index}, ${index}, ${JSON.stringify({ role: "user" })})`,
    )
  }
  yield* db.run(
    sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('mx', 'child_a', 1, 1, ${JSON.stringify({ role: "user" })})`,
  )
})

it.live("counts the messages of ONE session", () =>
  Effect.gen(function* () {
    yield* seed()
    expect(yield* ACPHistoryStore.countMessages("root")).toBe(7)
    expect(yield* ACPHistoryStore.countMessages("child_a")).toBe(1)
    expect(yield* ACPHistoryStore.countMessages("nobody")).toBe(0)
  }),
)

it.live("reads every descendant, oldest first, with depth and the row's totals, and nothing outside the tree", () =>
  Effect.gen(function* () {
    yield* seed()
    const result = yield* ACPHistoryStore.descendants("root")
    expect(result.truncated).toBe(false)
    expect(result.rows.map((row) => [row.id, row.parentId, row.depth])).toEqual([
      ["child_a", "root", 1],
      ["grandchild", "child_a", 2],
      ["child_b", "root", 1],
    ])
    expect(result.rows[2]).toMatchObject({
      title: "title child_b",
      agent: "explore",
      created: 30,
      tokens: { input: 500, output: 50, reasoning: 0, cacheRead: 1000, cacheWrite: 0 },
      cost: 0.5,
      steps: null,
    })
    expect((yield* ACPHistoryStore.descendants("child_b")).rows).toEqual([])
  }),
)

it.live("cuts at the limit and says so", () =>
  Effect.gen(function* () {
    yield* seed()
    const result = yield* ACPHistoryStore.descendants("root", 2)
    expect(result.rows.map((row) => row.id)).toEqual(["child_a", "grandchild"])
    expect(result.truncated).toBe(true)
  }),
)

// Lane L2 adds `session.steps`. This lane must read it when it is there and
// report null when it is not; the column is added and dropped inside the test.
it.live("reads the steps column when the store has one", () =>
  Effect.gen(function* () {
    yield* seed()
    const { db } = yield* Database.Service
    const has = yield* db
      .get<{ n: number }>(sql`SELECT count(*) AS n FROM pragma_table_info('session') WHERE name = 'steps'`)
      .pipe(Effect.orDie)
    const added = (has?.n ?? 0) === 0
    if (added) yield* db.run(sql`ALTER TABLE session ADD steps integer`)
    yield* db.run(sql`UPDATE session SET steps = 4 WHERE id = 'child_b'`)
    const rows = (yield* ACPHistoryStore.descendants("root")).rows
    if (added) yield* db.run(sql`ALTER TABLE session DROP COLUMN steps`)
    expect(rows.find((row) => row.id === "child_b")?.steps).toBe(4)
    expect(rows.find((row) => row.id === "child_a")?.steps).toBeNull()
  }),
)
