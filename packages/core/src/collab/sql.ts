import { sqliteTable, text, integer, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

/**
 * Collabs - persistent multi-agent conversation streams (M1).
 *
 * A Collab is an APPEND-ONLY message log plus a roster of agents. The log is
 * the only durable state: which agent is mid-turn, and whether the loop-breaker
 * has tripped, are both COMPUTED from the log rather than stored, so a restart
 * cannot leave a stale "running" flag or a permanently suspended stream behind.
 */

/**
 * What a log entry IS, rather than what its prose looks like. Routing reads this
 * field and never the text, so an `@name` written inside a sentence stays a
 * reference and wakes nobody.
 */
export type CollabMessageKind =
  | "say"
  | "ask"
  | "answer"
  | "handoff"
  | "task_open"
  | "task_claim"
  | "task_done"
  | "task_accept"
  | "task_reopen"
  | "system"
  // COUNCIL rooms only (`collab.flavor`). Four kinds rather than four flavours
  // of `say`, for the reason the whole vocabulary exists: routing, grouping and
  // the blind-round rule all read the kind, and prose can carry none of them.
  /** One member's INDEPENDENT answer in a round. It wakes nobody. */
  | "opinion"
  /** The synthesizer's reconciliation of one closed round. */
  | "synthesis"
  /** The round's own record: n of m answered, and who is missing from the n. */
  | "round"
  /** A follow-up the synthesizer put back to the council. Opens the next round. */
  | "council_question"

/** One tool an agent ran during the turn that produced a message. */
export type CollabTraceEntry = {
  readonly tool: string
  readonly summary: string
  readonly status: "ok" | "error"
}

/** Task board lifecycle. The legal moves between these live in the store. */
export type CollabTaskState = "open" | "claimed" | "done" | "accepted"

export const CollabTable = sqliteTable("collab", {
  id: text().primaryKey(),
  title: text().notNull(),
  /**
   * How many agent wakes one human message may pay for before autonomous
   * replies stop and the stream waits on a human. NULL = the engine default
   * (LOOP_BREAKER_DEFAULT), 0 = OFF (overnight mode). Nullable rather than
   * defaulted so "never configured" and "configured to the current default"
   * stay distinguishable - the default is an engine constant and may move.
   */
  loop_breaker_cap: integer(),
  /**
   * Who an unaddressed human message goes to. NULL means nobody: the post is
   * still recorded, and the shell is told no one was woken rather than the
   * whole room answering at once.
   */
  lead_slug: text(),
  /** The standing goal of the room, restated to every agent on every turn. */
  objective: text(),
  /**
   * How many participant turns this room may dispatch AT ONCE. NULL (and any
   * value below 2) = SERIAL, the one-turn-at-a-time default every room has
   * always run. Deliberately NOT spelled like `loop_breaker_cap`, where 0 means
   * OFF: an "off" concurrency would be a room with no ceiling on parallel
   * turns. See `CollabParallel.dispatchWidth`, which is the only reader.
   */
  concurrency: integer(),
  /**
   * What KIND of room this is. NULL (every room that shipped before this) and
   * any value a build does not recognise both read as `discuss` - today's
   * chain, unchanged. `council` makes the runner dispatch one question to every
   * member at once, blind to each other, and then synthesise.
   *
   * Text rather than a flag because the design report names more topologies
   * than these two, and a boolean would have to be replaced rather than
   * extended. See `CollabCouncil.flavorOf`, the only reader.
   */
  flavor: text(),
  ...Timestamps,
  time_archived: integer(),
})

export const CollabParticipantTable = sqliteTable(
  "collab_participant",
  {
    collab_id: text()
      .notNull()
      .references(() => CollabTable.id, { onDelete: "cascade" }),
    agent_slug: text().notNull(),
    /**
     * The agent's own persistent child session, created lazily on its first
     * turn. NULL until then: a roster entry that never speaks must not cost a
     * session row.
     */
    session_id: text(),
    /**
     * Highest log seq this agent has already been shown. The next turn's batch
     * is everything above it, so a burst of posts during one turn arrives as a
     * single follow-up instead of one turn per message.
     */
    last_seen_seq: integer().notNull().default(0),
    time_added: integer()
      .notNull()
      .$default(() => Date.now()),
    time_removed: integer(),
  },
  (table) => [primaryKey({ columns: [table.collab_id, table.agent_slug] })],
)

export const CollabMessageTable = sqliteTable(
  "collab_message",
  {
    id: text().primaryKey(),
    collab_id: text()
      .notNull()
      .references(() => CollabTable.id, { onDelete: "cascade" }),
    /** Per-collab, 1-based, gapless. The unique index below is what enforces it. */
    seq: integer().notNull(),
    /** "user" for a human post, else the agent slug that authored it. */
    author_id: text().notNull(),
    author_kind: text().$type<"human" | "agent">().notNull(),
    /** Defaulted so every row written before M4 reads as an ordinary say. */
    kind: text().$type<CollabMessageKind>().notNull().default("say"),
    text: text().notNull(),
    reply_to_seq: integer(),
    /** The agent slugs this message is addressed to. NULL = addressed to nobody. */
    mentions: text({ mode: "json" }).$type<string[]>(),
    /** The task board row this message belongs to, when it belongs to one. */
    task_id: text(),
    /** The tools the authoring turn ran, so the room can see the work claimed. */
    trace: text({ mode: "json" }).$type<CollabTraceEntry[]>(),
    /**
     * Images the human posted with this message, as `data:` URLs. NULL is the
     * ordinary case. Stored inline rather than as files on disk because the log
     * is the record: a message whose image had been cleaned up elsewhere would
     * read, later, as an agent answering about nothing.
     */
    images: text({ mode: "json" }).$type<string[]>(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [uniqueIndex("collab_message_collab_seq_idx").on(table.collab_id, table.seq)],
)

/**
 * The shared task board. Tasks are the unit of accountability between agents:
 * an `ask` creates one automatically, and a human can add one by hand.
 */
export const CollabTaskTable = sqliteTable("collab_task", {
  id: text().primaryKey(),
  collab_id: text()
    .notNull()
    .references(() => CollabTable.id, { onDelete: "cascade" }),
  title: text().notNull(),
  /** Whoever is on the hook right now. NULL while the task is still open. */
  owner_slug: text(),
  state: text().$type<CollabTaskState>().notNull(),
  created_by: text().notNull(),
  /** What the owner delivered, recorded when the task moves to done. */
  result: text(),
  /** Why the task was sent back, recorded when it is reopened. */
  note: text(),
  /** The log seq that created this task, when a message did. */
  origin_seq: integer(),
  ...Timestamps,
})

/**
 * One row per completed turn, including silent ones: a turn that said nothing
 * still spent tokens, and a ledger that hid those would understate the room.
 */
export const CollabTurnCostTable = sqliteTable("collab_turn_cost", {
  id: text().primaryKey(),
  collab_id: text()
    .notNull()
    .references(() => CollabTable.id, { onDelete: "cascade" }),
  agent_slug: text().notNull(),
  model: text().notNull(),
  tokens_input: integer().notNull(),
  tokens_output: integer().notNull(),
  cost: real().notNull(),
  /** The agent that asked for this turn, on a nested one. NULL at the top. */
  asked_by: text(),
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
})
