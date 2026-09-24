// t-ucndru (lazy loading L3, plan 5.4). The usage roll-up and `cache_stats`
// used `session.list`, which answers at most the 100 newest sessions (engine
// session/session.ts `listByProject`, `limit ?? 100`, newest `time_updated`
// first). With more than 100 sessions an older child fell out of the sum.
// These tests use a real (test) store with 150 sessions and the child as the
// OLDEST one.
//
// The sdk's `session.list` below answers what the engine's list answers: the
// same query `listByProject` runs, on the same store. So on the old code the
// roll-up missed the child; the new code does not call it.
import { expect } from "bun:test"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { OrigamiClient } from "@origami/sdk/v2"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@origami/core/database/database"
import { ACPHistoryStore } from "../../src/acp/history-store"
import { UsageService } from "../../src/acp/usage"
import * as ACPService from "../../src/acp/service"
import { testEffect } from "../lib/effect"

const truncate = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    for (const table of ["part", "message", "session", "project"]) {
      yield* db.run(sql`DELETE FROM ${sql.identifier(table)}`)
    }
  }),
)
const truncateNode = LayerNode.make({ name: "truncate-usage-descendants", layer: truncate, deps: [Database.node] })
const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, truncateNode])))

const TOTAL = 150

const session = Effect.fnUntraced(function* (
  id: string,
  parent: string | null,
  time: number,
  spend: { cost: number; input: number; output: number; read: number },
) {
  const { db } = yield* Database.Service
  yield* db.run(
    sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, cost,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          time_created, time_updated)
        VALUES (${id}, 'p1', ${parent}, ${id}, '/tmp/p1', ${id}, '0.0.0', ${spend.cost},
          ${spend.input}, ${spend.output}, 0, ${spend.read}, 0, ${time}, ${time})`,
  )
})

/** 150 sessions: the chat, its child as the OLDEST session of all, a grandchild,
 *  and 147 newer chats with nothing to do with it. */
const seed = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('p1', '/tmp/p1', '[]', 1, 1)`)
  yield* session("child", "root", 1, { cost: 0.5, input: 700, output: 90, read: 4000 })
  yield* session("grandchild", "child", 2, { cost: 0.25, input: 60, output: 10, read: 0 })
  for (let index = 0; index < TOTAL - 3; index++) {
    yield* session(`other_${index}`, null, 1000 + index, { cost: 0, input: 1, output: 1, read: 0 })
  }
  yield* session("root", null, 5000, { cost: 3, input: 999, output: 999, read: 0 })
})

/** What `sdk.session.list({ roots: false })` answers: listByProject's query. */
const engineList = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const rows = yield* db
    .all<{ id: string; parent_id: string | null; cost: number; tokens_input: number; tokens_output: number; tokens_cache_read: number }>(
      sql`SELECT id, parent_id, cost, tokens_input, tokens_output, tokens_cache_read FROM session
          WHERE project_id = 'p1' ORDER BY time_updated DESC LIMIT 100`,
    )
    .pipe(Effect.orDie)
  return rows.map((row) => ({
    id: row.id,
    ...(row.parent_id ? { parentID: row.parent_id } : {}),
    cost: row.cost,
    tokens: { input: row.tokens_input, output: row.tokens_output, cache: { read: row.tokens_cache_read, write: 0 } },
  }))
})

/** The real store reader, run against this test's store. */
const storeReader = Effect.fnUntraced(function* () {
  const context = yield* Effect.context<Database.Service>()
  const run = <A>(effect: Effect.Effect<A, never, Database.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(context)))
  return {
    countMessages: (id: string) => run(ACPHistoryStore.countMessages(id)),
    descendants: (id: string, limit?: number | null) => run(ACPHistoryStore.descendants(id, limit)),
    projectTokens: (id: string, directory?: string) => run(ACPHistoryStore.projectTokens(id, directory)),
  } satisfies ACPHistoryStore.Reader
})

it.live("the usage roll-up counts every descendant, a child older than the 100 newest sessions included", () =>
  Effect.gen(function* () {
    yield* seed()
    const listed = yield* engineList()
    // The fixture does what the ticket says: the child is outside the old listing.
    expect(listed.map((row) => row.id)).not.toContain("child")

    const sdk = {
      session: {
        messages: () =>
          Promise.resolve({
            data: [
              {
                info: {
                  role: "assistant",
                  providerID: "test",
                  modelID: "m",
                  cost: 3,
                  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
                },
                parts: [],
              },
            ],
          }),
        get: () => Promise.resolve({ data: { id: "root", cost: 3 } }),
        list: () => Promise.resolve({ data: listed }),
      },
      config: {
        providers: () =>
          Promise.resolve({
            data: { providers: [{ id: "test", models: { m: { id: "m", limit: { context: 1000, output: 100 } } } }] },
          }),
      },
    } as unknown as OrigamiClient
    const usage = UsageService.makeUsageService(sdk, () => null, yield* storeReader())
    const updates: SessionNotification[] = []
    const connection = {
      sessionUpdate: (params: SessionNotification) => {
        updates.push(params)
        return Promise.resolve()
      },
    }

    yield* usage.sendUpdate({ connection, sessionID: "root", directory: "/tmp/p1" })

    expect(updates).toHaveLength(1)
    // child + grandchild, and nothing of the 147 unrelated chats.
    expect((updates[0]?.update as { _meta?: Record<string, unknown> })._meta?.["subagents"]).toEqual({
      cost: 0.75,
      tokensInput: 760,
      tokensOutput: 100,
    })
  }),
)

it.live("cache_stats sums every session of the project, the oldest included", () =>
  Effect.gen(function* () {
    yield* seed()
    const listed = yield* engineList()
    const sdk = { session: { list: () => Promise.resolve({ data: listed }) } } as unknown as OrigamiClient
    const service = ACPService.make({ sdk, history: yield* storeReader() })

    const result = yield* service.cacheStats({ sessionId: "root" })

    expect(result.sessionCount).toBe(TOTAL)
    expect(result.current).toEqual({ input: 999, output: 999, cacheRead: 0, cacheWrite: 0 })
    // 147 x 1 + 700 + 60 + 999; the child's 4000 cache-read tokens are in the lifetime.
    expect(result.lifetime).toEqual({ input: 147 + 700 + 60 + 999, output: 147 + 90 + 10 + 999, cacheRead: 4000, cacheWrite: 0 })
  }),
)

it.live("descendants with limit null reads the whole tree; the roster default still cuts", () =>
  Effect.gen(function* () {
    yield* seed()
    for (let index = 0; index < ACPHistoryStore.ROSTER_MAX + 5; index++) {
      yield* session(`kid_${index}`, "other_0", 2000 + index, { cost: 0, input: 1, output: 1, read: 0 })
    }
    const all = yield* ACPHistoryStore.descendants("other_0", null)
    expect(all.rows).toHaveLength(ACPHistoryStore.ROSTER_MAX + 5)
    expect(all.truncated).toBe(false)
    const roster = yield* ACPHistoryStore.descendants("other_0")
    expect(roster.rows).toHaveLength(ACPHistoryStore.ROSTER_MAX)
    expect(roster.truncated).toBe(true)
  }),
)
