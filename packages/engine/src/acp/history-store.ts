export * as ACPHistoryStore from "./history-store"

import { Effect } from "effect"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "@origami/core/database/database"
import { SessionTable } from "@origami/core/session/sql"
import { AppRuntime } from "@/effect/app-runtime"
import type { UsageService } from "./usage"

/**
 * t-ucnjwp (lazy loading L4). The two store reads a bounded restore needs that
 * the HTTP API does not give: the message COUNT of a chat, and every DESCENDANT
 * row of a chat. Both are index reads (`message_session_time_created_id_idx`,
 * `session_parent_idx`) and neither reads a transcript.
 *
 * Reached in-process through the AppRuntime, the same way `StorageRetention`
 * is, so the reader is injected into `ACPService.make` by `ACP.init` only. A
 * service made without it reports no total and an empty roster.
 */

/** Rows past this are cut and the roster says `truncated`. */
export const ROSTER_MAX = 500

/** Guard against a parent cycle in a damaged store. Real trees are 1-3 deep. */
const MAX_DEPTH = 64

export type DescendantRow = {
  readonly id: string
  readonly parentId: string
  /** 1 = a direct child of the session the walk started at. */
  readonly depth: number
  readonly title: string
  readonly agent: string | null
  readonly created: number
  readonly updated: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  readonly cost: number
  /** The `steps` column (lane L2). NULL, or no column at all, is null. */
  readonly steps: number | null
}

export type Descendants = { readonly rows: readonly DescendantRow[]; readonly truncated: boolean }

export type Reader = {
  readonly countMessages: (sessionID: string) => Promise<number>
  /** `limit` as in `descendants`: absent = ROSTER_MAX, null = every row. */
  readonly descendants: (sessionID: string, limit?: number | null) => Promise<Descendants>
  /** t-uhxos2. The chat's sub-agent roster, fork sources included (`roster` below).
   *  Absent = the roster is `descendants` alone. */
  readonly roster?: (sessionID: string) => Promise<Descendants>
  /** t-ucndru. Absent = no store: `cache_stats` then answers with no rows. */
  readonly projectTokens?: (sessionID: string, directory?: string) => Promise<readonly UsageService.SessionRow[]>
}

export const countMessages = Effect.fn("ACPHistoryStore.countMessages")(function* (sessionID: string) {
  const { db } = yield* Database.Service
  const row = yield* db
    .get<{ n: number }>(sql`SELECT count(*) AS n FROM ${sql.identifier("message")} WHERE session_id = ${sessionID}`)
    .pipe(Effect.orDie)
  return row?.n ?? 0
})

type Raw = {
  id: string
  parent_id: string
  depth: number
  title: string
  agent: string | null
  time_created: number
  time_updated: number
  cost: number | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  steps: number | null
}

/**
 * Every descendant of `sessionID` (children, their children, ...), oldest first.
 * ONE recursive query. The `steps` column is read only when the store has it: lane
 * L2 adds it, and this lane must work on a store with or without it. The columns
 * are named, not `s.*`, because `summary_diffs` can hold whole file bodies.
 *
 * t-ucndru: `limit` null reads EVERY row. The usage roll-up (acp/usage.ts
 * `sendUpdate`) sums the whole tree, so a cut there would drop spend - the bug
 * `session.list` had, which stops at 100 rows.
 */
export const descendants = Effect.fn("ACPHistoryStore.descendants")(function* (
  sessionID: string,
  limit: number | null = ROSTER_MAX,
  /** t-uhxos2. Only direct children created before this (epoch ms), with all of
   *  their own descendants. Absent = every child. */
  before?: number,
) {
  const { db } = yield* Database.Service
  const column = yield* db
    .get<{ n: number }>(sql`SELECT count(*) AS n FROM pragma_table_info('session') WHERE name = 'steps'`)
    .pipe(Effect.orDie)
  const steps = (column?.n ?? 0) > 0 ? sql`s.steps` : sql`NULL`
  const rows = yield* db
    .all<Raw>(
      sql`WITH RECURSIVE tree(id, depth) AS (
            SELECT id, 1 FROM ${sql.identifier("session")} WHERE parent_id = ${sessionID}
              ${before === undefined ? sql`` : sql`AND time_created < ${before}`}
            UNION ALL
            SELECT c.id, tree.depth + 1 FROM ${sql.identifier("session")} c
              JOIN tree ON c.parent_id = tree.id
              WHERE tree.depth < ${MAX_DEPTH}
          )
          SELECT s.id, s.parent_id, tree.depth, s.title, s.agent, s.time_created, s.time_updated, s.cost,
            s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write,
            ${steps} AS steps
          FROM tree JOIN ${sql.identifier("session")} s ON s.id = tree.id
          ORDER BY s.time_created, s.id
          LIMIT ${limit === null ? -1 : limit + 1}`,
    )
    .pipe(Effect.orDie)
  return {
    rows: (limit === null ? rows : rows.slice(0, limit)).map(
      (row): DescendantRow => ({
        id: row.id,
        parentId: row.parent_id,
        depth: row.depth,
        title: row.title,
        agent: row.agent ?? null,
        created: row.time_created,
        updated: row.time_updated,
        tokens: {
          input: row.tokens_input ?? 0,
          output: row.tokens_output ?? 0,
          reasoning: row.tokens_reasoning ?? 0,
          cacheRead: row.tokens_cache_read ?? 0,
          cacheWrite: row.tokens_cache_write ?? 0,
        },
        cost: row.cost ?? 0,
        steps: typeof row.steps === "number" ? row.steps : null,
      }),
    ),
    truncated: limit !== null && rows.length > limit,
  } satisfies Descendants
})

/**
 * t-ucndru (lazy loading L3, plan 5.4). The token columns of EVERY session in the
 * project `sessionID` belongs to, and in `directory` when one is given: the rows
 * `cache_stats` sums for its lifetime figure. It used `session.list`, which stops
 * at the 100 newest rows (engine session/session.ts `listByProject`), so an older
 * session fell out of the lifetime. No limit here: five numbers per row.
 */
export const projectTokens = Effect.fn("ACPHistoryStore.projectTokens")(function* (
  sessionID: string,
  directory?: string,
) {
  const { db } = yield* Database.Service
  const own = yield* db
    .select({ project: SessionTable.project_id })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID as (typeof SessionTable.$inferSelect)["id"]))
    .get()
    .pipe(Effect.orDie)
  if (!own) return []
  const rows = yield* db
    .select({
      id: SessionTable.id,
      input: SessionTable.tokens_input,
      output: SessionTable.tokens_output,
      read: SessionTable.tokens_cache_read,
      write: SessionTable.tokens_cache_write,
    })
    .from(SessionTable)
    .where(
      and(eq(SessionTable.project_id, own.project), directory ? eq(SessionTable.directory, directory) : undefined),
    )
    .all()
    .pipe(Effect.orDie)
  return rows.map(
    (row): UsageService.SessionRow => ({
      id: row.id,
      tokens: { input: row.input, output: row.output, cache: { read: row.read, write: row.write } },
    }),
  )
})

/** t-uhxos2. Fork origins followed for one roster: a longer chain is cut here. */
export const FORK_CHAIN_MAX = 16
/** t-uhxos2. An OLD fork (no stored link): how many of its oldest messages are read
 *  for task cards that name the source. One page, the lazy-loading unit. */
export const OLD_FORK_SCAN = 50
/** `Session.fork`'s title (engine session/session.ts `getForkedTitle`). */
const FORK_TITLE = / \(fork #\d+\)$/

type Origin = { readonly source: string; readonly before: number }

/**
 * t-uhxos2. Where a chat's copied history came from. A fork stores its source and
 * fork point (`fork_session_id`, `fork_time`). A fork made before those columns
 * has neither; for it (only when the title is a fork title) the task cards in its
 * OLDEST `OLD_FORK_SCAN` messages name sub-agents, and their `parent_id` is the
 * source. Its fork point is then its own creation time. Bounded: one page of parts.
 */
const origins = Effect.fnUntraced(function* (sessionID: string) {
  const { db } = yield* Database.Service
  const row = yield* db
    .get<{ fork_session_id: string | null; fork_time: number | null; title: string; time_created: number }>(
      sql`SELECT fork_session_id, fork_time, title, time_created FROM ${sql.identifier("session")} WHERE id = ${sessionID}`,
    )
    .pipe(Effect.orDie)
  if (!row) return [] as Origin[]
  if (row.fork_session_id && typeof row.fork_time === "number") {
    return [{ source: row.fork_session_id, before: row.fork_time }]
  }
  if (!FORK_TITLE.test(row.title)) return [] as Origin[]
  const parents = yield* db
    .all<{ parent_id: string }>(
      sql`SELECT DISTINCT c.parent_id FROM ${sql.identifier("part")} p
          JOIN ${sql.identifier("session")} c ON c.id = json_extract(p.data, '$.state.metadata.sessionId')
          WHERE p.message_id IN (
              SELECT id FROM ${sql.identifier("message")} WHERE session_id = ${sessionID}
              ORDER BY time_created, id LIMIT ${OLD_FORK_SCAN})
            AND json_extract(p.data, '$.type') = 'tool' AND json_extract(p.data, '$.tool') = 'task'
            AND c.parent_id IS NOT NULL AND c.parent_id != ${sessionID}`,
    )
    .pipe(Effect.orDie)
  return parents.map((parent): Origin => ({ source: parent.parent_id, before: row.time_created }))
})

/**
 * t-uhxos2. The sub-agent roster of a chat: its own descendants, plus, for a fork,
 * its source's descendants created before the fork point, following a chain of forks
 * (a source's own fork point bounds its source's children further). These are the
 * sub-agents the chat's history has task cards for - the set 0.4.172 drew from a whole
 * replay. Oldest first, at most `limit` rows.
 */
export const roster = Effect.fn("ACPHistoryStore.roster")(function* (sessionID: string, limit: number = ROSTER_MAX) {
  const seen = new Set([sessionID])
  const queue: { id: string; before?: number }[] = [{ id: sessionID }]
  const rows = new Map<string, DescendantRow>()
  let truncated = false
  for (let step = 0; step < FORK_CHAIN_MAX && queue.length > 0; step++) {
    const node = queue.shift()!
    const tree = yield* descendants(node.id, limit, node.before)
    truncated ||= tree.truncated
    for (const row of tree.rows) if (!rows.has(row.id)) rows.set(row.id, row)
    for (const origin of yield* origins(node.id)) {
      if (seen.has(origin.source)) continue
      seen.add(origin.source)
      queue.push({
        id: origin.source,
        before: node.before === undefined ? origin.before : Math.min(node.before, origin.before),
      })
    }
  }
  const sorted = [...rows.values()].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { rows: sorted.slice(0, limit), truncated: truncated || sorted.length > limit } satisfies Descendants
})

/** The production reader: the process-wide store. */
export const live: Reader = {
  countMessages: (sessionID) => AppRuntime.runPromise(countMessages(sessionID)),
  descendants: (sessionID, limit) => AppRuntime.runPromise(descendants(sessionID, limit)),
  roster: (sessionID) => AppRuntime.runPromise(roster(sessionID)),
  projectTokens: (sessionID, directory) => AppRuntime.runPromise(projectTokens(sessionID, directory)),
}
