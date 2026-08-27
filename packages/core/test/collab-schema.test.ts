import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@origami/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@origami/core/database/migration"
import collabTablesMigration from "@origami/core/database/migration/20260804174036_add_collab_tables"
import flockM4Migration from "@origami/core/database/migration/20260805114117_flock_m4"
import collabImagesMigration from "@origami/core/database/migration/20260805182109_collab_images"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

/** A database that has been through the tracked migrations, as a fresh install would. */
const migrated = Effect.gen(function* () {
  const db = yield* makeDb
  yield* db.run(sql`PRAGMA foreign_keys = ON`)
  yield* DatabaseMigration.apply(db)
  return db
})

describe("Collab schema", () => {
  test("a fresh database boots with every collab table and the sequence index", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* migrated

        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('collab', 'collab_participant', 'collab_message', 'collab_task', 'collab_turn_cost') ORDER BY name`,
          ),
        ).toEqual([
          { name: "collab" },
          { name: "collab_message" },
          { name: "collab_participant" },
          { name: "collab_task" },
          { name: "collab_turn_cost" },
        ])

        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'collab_message_collab_seq_idx'`,
          ),
        ).toEqual({ name: "collab_message_collab_seq_idx" })
      }),
    )
  })

  test("the M4 columns land on an existing collab without disturbing what is stored", async () => {
    expect(
      await run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* DatabaseMigration.applyOnly(db, [collabTablesMigration])
          // A collab from before M4, with a deliberately configured cap.
          yield* db.run(
            sql`INSERT INTO collab (id, title, loop_breaker_cap, time_created, time_updated) VALUES ('c1', 'Ship it', 3, 1, 1)`,
          )
          yield* db.run(
            sql`INSERT INTO collab_message (id, collab_id, seq, author_id, author_kind, text, time_created) VALUES ('m1', 'c1', 1, 'user', 'human', 'hello', 1)`,
          )

          yield* DatabaseMigration.applyOnly(db, [flockM4Migration])

          return {
            // The cap keeps its name, its value and its null/0 semantics: its
            // MEANING changed, the stored rows did not.
            collab: yield* db.get(
              sql`SELECT title, loop_breaker_cap, lead_slug, objective FROM collab WHERE id = 'c1'`,
            ),
            // Every message written before M4 reads as an ordinary say.
            message: yield* db.get(sql`SELECT kind, mentions, task_id, trace FROM collab_message WHERE id = 'm1'`),
            tables: yield* db.all(
              sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('collab_task', 'collab_turn_cost') ORDER BY name`,
            ),
          }
        }),
      ),
    ).toEqual({
      collab: { title: "Ship it", loop_breaker_cap: 3, lead_slug: null, objective: null },
      message: { kind: "say", mentions: null, task_id: null, trace: null },
      tables: [{ name: "collab_task" }, { name: "collab_turn_cost" }],
    })
  })

  test("the images column lands on an existing log, and every older message reads as image-free", async () => {
    expect(
      await run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* DatabaseMigration.applyOnly(db, [collabTablesMigration, flockM4Migration])
          yield* db.run(sql`INSERT INTO collab (id, title, time_created, time_updated) VALUES ('c1', 'Ship it', 1, 1)`)
          // A message written before images existed.
          yield* db.run(
            sql`INSERT INTO collab_message (id, collab_id, seq, author_id, author_kind, text, time_created) VALUES ('m1', 'c1', 1, 'user', 'human', 'hello', 1)`,
          )

          yield* DatabaseMigration.applyOnly(db, [collabImagesMigration])

          // A new message CAN carry them, as the JSON array the store writes.
          yield* db.run(
            sql`INSERT INTO collab_message (id, collab_id, seq, author_id, author_kind, text, images, time_created) VALUES ('m2', 'c1', 2, 'user', 'human', 'look', '["data:image/png;base64,AAA="]', 2)`,
          )
          return {
            old: yield* db.get(sql`SELECT text, images FROM collab_message WHERE id = 'm1'`),
            fresh: yield* db.get(sql`SELECT text, images FROM collab_message WHERE id = 'm2'`),
          }
        }),
      ),
    ).toEqual({
      // NULL, not an empty array: "this message has no images" is the absence
      // of the column's value, and every row written before today says it.
      old: { text: "hello", images: null },
      fresh: { text: "look", images: '["data:image/png;base64,AAA="]' },
    })
  })

  test("deleting a collab takes its board and its ledger with it", async () => {
    expect(
      await run(
        Effect.gen(function* () {
          const db = yield* migrated
          yield* db.run(sql`INSERT INTO collab (id, title, time_created, time_updated) VALUES ('c1', 'One', 1, 1)`)
          yield* db.run(
            sql`INSERT INTO collab_task (id, collab_id, title, state, created_by, time_created, time_updated) VALUES ('t1', 'c1', 'ship it', 'open', 'user', 1, 1)`,
          )
          yield* db.run(
            sql`INSERT INTO collab_turn_cost (id, collab_id, agent_slug, model, tokens_input, tokens_output, cost, time_created) VALUES ('k1', 'c1', 'alice', 'lmstudio/qwen3-coder', 10, 2, 0.5, 1)`,
          )
          yield* db.run(sql`DELETE FROM collab WHERE id = 'c1'`)
          return {
            tasks: yield* db.get(sql`SELECT count(*) as count FROM collab_task`),
            costs: yield* db.get(sql`SELECT count(*) as count FROM collab_turn_cost`),
          }
        }),
      ),
    ).toEqual({ tasks: { count: 0 }, costs: { count: 0 } })
  })

  test("the same sequence number cannot be used twice in one collab", async () => {
    expect(
      await run(
        Effect.gen(function* () {
          const db = yield* migrated
          yield* db.run(sql`INSERT INTO collab (id, title, time_created, time_updated) VALUES ('c1', 'Ship it', 1, 1)`)
          yield* db.run(
            sql`INSERT INTO collab_message (id, collab_id, seq, author_id, author_kind, text, time_created) VALUES ('m1', 'c1', 1, 'user', 'human', 'hello', 1)`,
          )
          const second = yield* db
            .run(
              sql`INSERT INTO collab_message (id, collab_id, seq, author_id, author_kind, text, time_created) VALUES ('m2', 'c1', 1, 'alice', 'agent', 'hi', 2)`,
            )
            .pipe(Effect.exit)
          return {
            rejected: Exit.isFailure(second),
            stored: yield* db.get(sql`SELECT count(*) as count FROM collab_message`),
          }
        }),
      ),
    ).toEqual({ rejected: true, stored: { count: 1 } })
  })

  test("two collabs number their own logs independently", async () => {
    expect(
      await run(
        Effect.gen(function* () {
          const db = yield* migrated
          yield* db.run(sql`INSERT INTO collab (id, title, time_created, time_updated) VALUES ('c1', 'One', 1, 1)`)
          yield* db.run(sql`INSERT INTO collab (id, title, time_created, time_updated) VALUES ('c2', 'Two', 1, 1)`)
          yield* db.run(
            sql`INSERT INTO collab_message (id, collab_id, seq, author_id, author_kind, text, time_created) VALUES ('m1', 'c1', 1, 'user', 'human', 'a', 1)`,
          )
          yield* db.run(
            sql`INSERT INTO collab_message (id, collab_id, seq, author_id, author_kind, text, time_created) VALUES ('m2', 'c2', 1, 'user', 'human', 'b', 1)`,
          )
          return yield* db.get(sql`SELECT count(*) as count FROM collab_message`)
        }),
      ),
    ).toEqual({ count: 2 })
  })

  test("one agent joins a collab once", async () => {
    expect(
      await run(
        Effect.gen(function* () {
          const db = yield* migrated
          yield* db.run(sql`INSERT INTO collab (id, title, time_created, time_updated) VALUES ('c1', 'One', 1, 1)`)
          yield* db.run(
            sql`INSERT INTO collab_participant (collab_id, agent_slug, last_seen_seq, time_added) VALUES ('c1', 'alice', 0, 1)`,
          )
          const again = yield* db
            .run(
              sql`INSERT INTO collab_participant (collab_id, agent_slug, last_seen_seq, time_added) VALUES ('c1', 'alice', 0, 2)`,
            )
            .pipe(Effect.exit)
          return {
            rejected: Exit.isFailure(again),
            stored: yield* db.get(sql`SELECT count(*) as count FROM collab_participant`),
          }
        }),
      ),
    ).toEqual({ rejected: true, stored: { count: 1 } })
  })

  test("deleting a collab takes its roster and its log with it", async () => {
    expect(
      await run(
        Effect.gen(function* () {
          const db = yield* migrated
          yield* db.run(sql`INSERT INTO collab (id, title, time_created, time_updated) VALUES ('c1', 'One', 1, 1)`)
          yield* db.run(
            sql`INSERT INTO collab_participant (collab_id, agent_slug, last_seen_seq, time_added) VALUES ('c1', 'alice', 0, 1)`,
          )
          yield* db.run(
            sql`INSERT INTO collab_message (id, collab_id, seq, author_id, author_kind, text, time_created) VALUES ('m1', 'c1', 1, 'user', 'human', 'a', 1)`,
          )
          yield* db.run(sql`DELETE FROM collab WHERE id = 'c1'`)
          return {
            participants: yield* db.get(sql`SELECT count(*) as count FROM collab_participant`),
            messages: yield* db.get(sql`SELECT count(*) as count FROM collab_message`),
          }
        }),
      ),
    ).toEqual({ participants: { count: 0 }, messages: { count: 0 } })
  })
})
