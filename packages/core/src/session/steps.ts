export * as SessionSteps from "./steps"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"

type DatabaseService = Database.Interface["db"]

/**
 * The per-session `steps` column (t-ucn8zm, lazy loading L2).
 *
 * THE RULE is the old `RunStats.stat(...).steps` (engine `acp/run-stats.ts`),
 * which read the whole transcript to get it:
 *  - only assistant messages that are not foreign (`ForeignTranscript.isForeign`:
 *    a non-empty string `source`);
 *  - a message with step-finish parts that have finite `tokens.input` and
 *    `tokens.output` adds one per such part;
 *  - a message with none adds one if its own `tokens.input` and `tokens.output`
 *    are finite.
 *
 * So one message adds `contribution(shape(info), n)`, n = its counting parts.
 * The backfill below applies the rule in SQL; the projector keeps the column
 * current with the same rule, message by message. The fallback is not rare:
 * an aborted or failed request is saved with zero message tokens and no
 * step-finish part, and the old rule counts it (209 such messages in the 30
 * days before 2026-09-24 on the owner's store, 75 of them in sub-agents).
 *
 * NULL means "not counted yet". A row made before the column existed stays NULL
 * until `backfill` reaches it, and the projector's `steps + 1` keeps a NULL NULL,
 * so an increment never races the backfill.
 */

/** True for a part that counts as one step: a step-finish part with finite
 *  input and output tokens. The same bar as `stepSpend` in run-stats.ts. */
export function counts(part: unknown): boolean {
  if (typeof part !== "object" || part === null) return false
  const value = part as { type?: unknown; tokens?: { input?: unknown; output?: unknown } }
  if (value.type !== "step-finish") return false
  return finite(value.tokens?.input) && finite(value.tokens?.output)
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
}

export type Shape = { readonly eligible: boolean; readonly fallback: boolean }

/** A message that is absent adds nothing. */
export const NONE: Shape = { eligible: false, fallback: false }

/** What the rule needs from a message's info (the stored `message.data`). */
export function shape(info: unknown): Shape {
  if (typeof info !== "object" || info === null) return NONE
  const value = info as { role?: unknown; source?: unknown; tokens?: { input?: unknown; output?: unknown } }
  const foreign = typeof value.source === "string" && value.source.length > 0
  return {
    eligible: value.role === "assistant" && !foreign,
    fallback: finite(value.tokens?.input) && finite(value.tokens?.output),
  }
}

/** Steps one message adds, given its shape and its number of counting parts. */
export function contribution(value: Shape, parts: number): number {
  if (!value.eligible) return 0
  return Math.max(parts, value.fallback ? 1 : 0)
}

// JSON has no NaN or Infinity, so a stored JSON number is always finite.
const number = (path: string) => sql.raw(`json_type(${path}) IN ('integer', 'real')`)

/** `counts` in SQL, for a part row aliased `p`. */
const countingPart = sql`json_extract(p.data, '$.type') = 'step-finish'
  AND ${number("p.data, '$.tokens.input'")}
  AND ${number("p.data, '$.tokens.output'")}`

/** Counting parts of one message. Reads that message's parts only. */
export function countingParts(db: DatabaseService, messageID: string) {
  return db
    .get<{ n: number }>(sql`SELECT count(*) AS n FROM part p WHERE p.message_id = ${messageID} AND ${countingPart}`)
    .pipe(Effect.map((row) => row?.n ?? 0))
}

/** True if the message has a counting part other than `partID`. Stops at the first. */
export function otherCountingPart(db: DatabaseService, messageID: string, partID: string) {
  return db
    .get<{ found: number }>(
      sql`SELECT EXISTS (SELECT 1 FROM part p WHERE p.message_id = ${messageID} AND p.id <> ${partID} AND ${countingPart}) AS found`,
    )
    .pipe(Effect.map((row) => row?.found === 1))
}

/** The rule above as one SQL value for the session row being updated. `max(n, 0|1)`
 *  gives n when the message has counting step-finish parts (n >= 1), and the
 *  message-level fallback otherwise. */
const count = sql`coalesce((
  SELECT sum(max(
    (SELECT count(*) FROM part p WHERE p.message_id = m.id AND ${countingPart}),
    CASE WHEN ${number("m.data, '$.tokens.input'")} AND ${number("m.data, '$.tokens.output'")} THEN 1 ELSE 0 END))
  FROM message m
  WHERE m.session_id = session.id
    AND json_extract(m.data, '$.role') = 'assistant'
    AND (json_type(m.data, '$.source') IS NOT 'text' OR json_extract(m.data, '$.source') = '')
), 0)`

/**
 * Counts one session, if it is still NULL. IMMEDIATE takes the write lock before
 * the count reads anything. The projector writes a part and its `steps + 1` in
 * one IMMEDIATE transaction too, so every part is either in this count or is
 * added to it afterwards, never both and never neither.
 */
export function backfillSession(db: DatabaseService, sessionID: string) {
  return db.transaction(
    (tx) => tx.run(sql`UPDATE session SET steps = ${count} WHERE id = ${sessionID} AND steps IS NULL`),
    { behavior: "immediate" },
  )
}

/**
 * The background backfill (owner Q4: the one-statement form in the migration
 * took 3.8-4.9 s on a warm copy of the 16 GB store: too near the 5 s limit, and
 * one write lock held for most of the 5 s busy_timeout that another engine
 * starting at the same time waits). On the same copy this job took 4.3 s for
 * 2,285 sessions, 149 ms for the largest one.
 *
 * One session per transaction, a yield between sessions, children first (the
 * sub-agent card is what reads `steps`), newest first inside each group. It only
 * ever touches NULL rows, so a stop at any point loses nothing: the next start
 * goes on from where this one ended.
 */
export function backfill(db: DatabaseService) {
  return Effect.gen(function* () {
    const pending = yield* db.all<{ id: string }>(
      sql`SELECT id FROM session WHERE steps IS NULL ORDER BY parent_id IS NULL, time_updated DESC`,
    )
    if (pending.length === 0) return
    const started = Date.now()
    for (const row of pending) {
      yield* backfillSession(db, row.id)
      yield* Effect.yieldNow
    }
    yield* Effect.logInfo("session steps backfilled", { sessions: pending.length, ms: Date.now() - started })
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("session steps backfill stopped", { cause })))
}
