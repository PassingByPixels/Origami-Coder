import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Database } from "@origami/core/database/database"
import {
  CollabMessageTable,
  CollabParticipantTable,
  CollabTable,
  CollabTaskTable,
  CollabTurnCostTable,
  type CollabMessageKind,
  type CollabTaskState,
  type CollabTraceEntry,
} from "@origami/core/collab/sql"
import { Identifier } from "@/id/id"

/**
 * Durable state for Collabs. Everything the feature persists lives here; the
 * runner keeps only per-process turn status, which is why a restart cannot
 * strand a stream in "running".
 */

export type AuthorKind = "human" | "agent"

export type MessageKind = CollabMessageKind
export type TraceEntry = CollabTraceEntry
export type TaskState = CollabTaskState

/** The board moves a caller may ask for. Each one maps to exactly one transition. */
export type TaskAction = "claim" | "done" | "accept" | "reopen"

export type Collab = {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt?: number
  /** null = engine default (LOOP_BREAKER_DEFAULT), 0 = off, N > 0 = cap. */
  readonly loopBreakerCap: number | null
  /** The agent an unaddressed human message wakes. null = nobody. */
  readonly lead: string | null
  readonly objective: string | null
  /**
   * How many participant turns this room dispatches at once. null (and anything
   * below 2) = SERIAL, which is every room that never opted in.
   */
  readonly concurrency: number | null
  /**
   * What KIND of room this is. null = never configured, which is `discuss` -
   * the chain every room has always run. Stored RAW: `CollabCouncil.flavorOf`
   * is the only reader and resolves anything it does not know to `discuss`.
   */
  readonly flavor: string | null
}

export type Participant = {
  readonly collabId: string
  readonly agentSlug: string
  readonly sessionId: string | null
  readonly lastSeenSeq: number
  readonly addedAt: number
  readonly removedAt?: number
}

export type Message = {
  readonly id: string
  readonly collabId: string
  readonly seq: number
  readonly authorId: string
  readonly authorKind: AuthorKind
  readonly kind: MessageKind
  readonly text: string
  readonly replyToSeq?: number
  /** The slugs this message addresses. Empty means it addresses nobody. */
  readonly mentions: readonly string[]
  readonly taskId: string | null
  readonly trace: readonly TraceEntry[] | null
  /** The images the human attached, as `data:` URLs. Absent on almost every row. */
  readonly images?: readonly string[]
  readonly createdAt: number
}

export type AppendInput = {
  readonly collabId: string
  readonly authorId: string
  readonly authorKind: AuthorKind
  /** Absent is an ordinary room message. */
  readonly kind?: MessageKind
  readonly text: string
  readonly replyToSeq?: number
  readonly mentions?: readonly string[]
  readonly taskId?: string
  readonly trace?: readonly TraceEntry[]
  /**
   * Images posted with this message, as `data:` URLs. Validate with
   * {@link imageRefusal} BEFORE calling: this writes what it is handed.
   */
  readonly images?: readonly string[]
}

export type Task = {
  readonly id: string
  readonly collabId: string
  readonly title: string
  readonly owner: string | null
  readonly state: TaskState
  readonly createdBy: string
  readonly result: string | null
  readonly note: string | null
  readonly originSeq: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

export type TaskInput = {
  readonly collabId: string
  readonly title: string
  readonly createdBy: string
  /** Set together with `state: "claimed"` when a task is born already owned. */
  readonly owner?: string
  /** Absent opens the task. An `ask` creates one already claimed by its target. */
  readonly state?: TaskState
  readonly originSeq?: number
}

export type TaskUpdate = {
  readonly collabId: string
  readonly taskId: string
  readonly action: TaskAction
  readonly owner?: string
  readonly result?: string
  readonly note?: string
}

export type LedgerEntry = {
  readonly id: string
  readonly collabId: string
  readonly agentSlug: string
  readonly model: string
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly cost: number
  /** The agent that asked for this turn, on a nested one. null at the top. */
  readonly askedBy: string | null
  readonly createdAt: number
}

export type LedgerInput = {
  readonly collabId: string
  readonly agentSlug: string
  readonly model: string
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly cost: number
  readonly askedBy?: string
}

export type CostTotal = {
  readonly agentSlug: string
  readonly cost: number
  readonly tokensInput: number
  readonly tokensOutput: number
}

export interface Interface {
  readonly create: (input: {
    title: string
    agentSlugs: readonly string[]
    objective?: string
  }) => Effect.Effect<Collab>
  readonly list: () => Effect.Effect<Collab[]>
  readonly get: (collabId: string) => Effect.Effect<Collab | undefined>
  readonly archive: (collabId: string, time?: number) => Effect.Effect<void>
  /** The inverse of {@link Interface.archive}. Clears the stamp, nothing else. */
  readonly unarchive: (collabId: string) => Effect.Effect<void>
  readonly rename: (collabId: string, title: string) => Effect.Effect<void>
  readonly setCap: (collabId: string, cap: number | null) => Effect.Effect<void>
  /** null (and anything below 2) restores the SERIAL default. */
  readonly setConcurrency: (collabId: string, concurrency: number | null) => Effect.Effect<void>
  /** null (and anything unrecognised) restores the `discuss` default. */
  readonly setFlavor: (collabId: string, flavor: string | null) => Effect.Effect<void>
  /** null clears the lead outright; roster changes never re-promote over it. */
  readonly setLead: (collabId: string, agentSlug: string | null) => Effect.Effect<void>
  readonly setObjective: (collabId: string, objective: string) => Effect.Effect<void>
  readonly addParticipants: (collabId: string, agentSlugs: readonly string[]) => Effect.Effect<void>
  /** Add one agent, or bring a removed one back. Keeps its session and marker. */
  readonly addParticipant: (collabId: string, agentSlug: string) => Effect.Effect<void>
  /** Soft delete. The row, its session and its messages all stay. */
  readonly removeParticipant: (collabId: string, agentSlug: string, time?: number) => Effect.Effect<void>
  readonly participants: (collabId: string) => Effect.Effect<Participant[]>
  readonly setParticipantSession: (collabId: string, agentSlug: string, sessionId: string) => Effect.Effect<void>
  readonly setLastSeen: (collabId: string, agentSlug: string, seq: number) => Effect.Effect<void>
  readonly appendMessage: (input: AppendInput) => Effect.Effect<Message>
  readonly listMessages: (collabId: string, sinceSeq?: number) => Effect.Effect<Message[]>
  readonly addTask: (input: TaskInput) => Effect.Effect<Task>
  /**
   * Point a task at the message that created it. Separate from `addTask`
   * because an `ask` needs the task's id to put ON that message, so the
   * message's sequence number only exists one write later.
   */
  readonly setTaskOrigin: (collabId: string, taskId: string, seq: number) => Effect.Effect<void>
  /** Applies ONE legal transition. An illegal one is a defect, not a value. */
  readonly updateTask: (input: TaskUpdate) => Effect.Effect<Task>
  readonly getTask: (collabId: string, taskId: string) => Effect.Effect<Task | undefined>
  /** Every task of one collab, oldest first. Board ordering is a wire concern. */
  readonly listTasks: (collabId: string) => Effect.Effect<Task[]>
  readonly appendCost: (input: LedgerInput) => Effect.Effect<LedgerEntry>
  readonly listCosts: (collabId: string, limit?: number) => Effect.Effect<LedgerEntry[]>
  readonly costTotals: (collabId: string) => Effect.Effect<CostTotal[]>
}

export class Service extends Context.Service<Service, Interface>()("@origami/Collab/Store") {}

/** How many tools one message's trace keeps before it is summarised. */
export const TRACE_LIMIT = 20
/** How much of one tool's argument summary survives. */
export const TRACE_SUMMARY_LIMIT = 120

/**
 * Bound one trace before it is stored. Enforced HERE rather than at each caller
 * so a chatty turn cannot put an unbounded blob on a row that every later turn
 * then reads back as context.
 */
export function boundTrace(entries: readonly TraceEntry[]): TraceEntry[] {
  const clipped = entries.slice(0, TRACE_LIMIT).map((entry) => ({
    tool: entry.tool,
    summary: entry.summary.slice(0, TRACE_SUMMARY_LIMIT),
    status: entry.status,
  }))
  const dropped = entries.length - clipped.length
  if (dropped > 0) clipped.push({ tool: "…", summary: `+${dropped} more`, status: "ok" })
  return clipped
}

/** How many images one message may carry. */
export const IMAGE_LIMIT = 4
/** The largest ONE image may be, decoded. */
export const IMAGE_BYTES_MAX = 2 * 1024 * 1024

/**
 * What a base64 `data:` URL weighs once decoded, near enough to enforce a limit
 * on. Four characters carry three bytes, and the trailing `=` padding carries
 * none - so this is exact for well-formed base64.
 *
 * A URL with no comma at all has no payload to find, so the whole string is
 * measured. That OVER-states it, which is the safe direction for a bound: a
 * malformed URL is refused rather than let through under-measured.
 */
export function decodedBytes(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1)
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

/**
 * Why a set of posted images is refused, or undefined when they are legal.
 *
 * Lives here beside {@link taskRefusal} for the same reason: the ACP layer turns
 * a refusal into a message the human reads, and the policy has to be written
 * down in exactly one place. Every refusal NAMES the limit it hit - a human
 * told only "refused" is left guessing which of three rules they broke.
 */
export function imageRefusal(images: readonly string[]): string | undefined {
  if (images.length > IMAGE_LIMIT) {
    return `a message may carry at most ${IMAGE_LIMIT} images, this one has ${images.length}`
  }
  for (const [index, image] of images.entries()) {
    if (!image.startsWith("data:")) {
      return `image ${index + 1} is not a data: URL - a collab image must be inlined, not linked`
    }
    const bytes = decodedBytes(image)
    if (bytes > IMAGE_BYTES_MAX) {
      return `image ${index + 1} is ${Math.round(bytes / 1024)}KB, over the ${IMAGE_BYTES_MAX / 1024 / 1024}MB limit per image`
    }
  }
  return undefined
}

/**
 * The task board's whole policy, in one table. Both the ACP layer (which turns
 * a refusal into a method error the human can read) and the store (which treats
 * one as a defect, because it should never have been asked) read this, so there
 * is exactly one place the legal moves are written down.
 *
 * Returns the reason a move is refused, or undefined when it is legal.
 */
export function taskRefusal(task: Task, input: Pick<TaskUpdate, "action" | "owner" | "result" | "note">) {
  switch (input.action) {
    case "claim":
      if (task.state !== "open") return `task is ${task.state}, only an open task can be claimed`
      if (!input.owner) return "claiming a task requires an owner"
      return undefined
    case "done":
      if (task.state !== "claimed") return `task is ${task.state}, only a claimed task can be completed`
      if (!input.result) return "completing a task requires a result"
      return undefined
    case "accept":
      if (task.state !== "done") return `task is ${task.state}, only a completed task can be accepted`
      return undefined
    case "reopen":
      if (task.state !== "done") return `task is ${task.state}, only a completed task can be reopened`
      if (!input.note) return "reopening a task requires a note"
      return undefined
  }
}

/** The state one legal action lands the task in. */
const TASK_NEXT: Record<TaskAction, TaskState> = {
  claim: "claimed",
  done: "done",
  accept: "accepted",
  reopen: "claimed",
}

const collabOf = (row: typeof CollabTable.$inferSelect): Collab => ({
  id: row.id,
  title: row.title,
  createdAt: row.time_created,
  updatedAt: row.time_updated,
  ...(row.time_archived !== null ? { archivedAt: row.time_archived } : {}),
  loopBreakerCap: row.loop_breaker_cap,
  lead: row.lead_slug,
  objective: row.objective,
  concurrency: row.concurrency,
  flavor: row.flavor,
})

const participantOf = (row: typeof CollabParticipantTable.$inferSelect): Participant => ({
  collabId: row.collab_id,
  agentSlug: row.agent_slug,
  sessionId: row.session_id,
  lastSeenSeq: row.last_seen_seq,
  addedAt: row.time_added,
  ...(row.time_removed !== null ? { removedAt: row.time_removed } : {}),
})

const messageOf = (row: typeof CollabMessageTable.$inferSelect): Message => ({
  id: row.id,
  collabId: row.collab_id,
  seq: row.seq,
  authorId: row.author_id,
  authorKind: row.author_kind,
  kind: row.kind,
  text: row.text,
  ...(row.reply_to_seq !== null ? { replyToSeq: row.reply_to_seq } : {}),
  mentions: row.mentions ?? [],
  taskId: row.task_id,
  trace: row.trace,
  // Omitted rather than `[]`: every row written before images existed reads as
  // NULL, and a shell that tests presence must not see an empty array on it.
  ...(row.images && row.images.length > 0 ? { images: row.images } : {}),
  createdAt: row.time_created,
})

const taskOf = (row: typeof CollabTaskTable.$inferSelect): Task => ({
  id: row.id,
  collabId: row.collab_id,
  title: row.title,
  owner: row.owner_slug,
  state: row.state,
  createdBy: row.created_by,
  result: row.result,
  note: row.note,
  originSeq: row.origin_seq,
  createdAt: row.time_created,
  updatedAt: row.time_updated,
})

const costOf = (row: typeof CollabTurnCostTable.$inferSelect): LedgerEntry => ({
  id: row.id,
  collabId: row.collab_id,
  agentSlug: row.agent_slug,
  model: row.model,
  tokensInput: row.tokens_input,
  tokensOutput: row.tokens_output,
  cost: row.cost,
  askedBy: row.asked_by,
  createdAt: row.time_created,
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const load = (collabId: string) =>
      db.select().from(CollabTable).where(eq(CollabTable.id, collabId)).get().pipe(Effect.orDie)

    /** The active roster in JOIN order, which is the promotion order for the lead. */
    const activeSlugs = (collabId: string) =>
      db
        .select({ agentSlug: CollabParticipantTable.agent_slug })
        .from(CollabParticipantTable)
        .where(and(eq(CollabParticipantTable.collab_id, collabId), isNull(CollabParticipantTable.time_removed)))
        .orderBy(asc(CollabParticipantTable.time_added), asc(CollabParticipantTable.agent_slug))
        .all()
        .pipe(Effect.orDie)

    /**
     * Keep `lead_slug` on an agent that is actually in the room.
     *
     * Run after every roster change: a collab with no lead takes the FIRST
     * active agent, and removing the lead promotes the next by join order, or
     * nobody when the room empties. A deliberate `setLead(null)` therefore
     * survives until the next roster change, which is the only event the
     * contract lets fill an empty seat.
     */
    const syncLead = Effect.fnUntraced(function* (collabId: string) {
      const collab = yield* load(collabId)
      if (!collab) return
      const active = yield* activeSlugs(collabId)
      if (collab.lead_slug !== null && active.some((entry) => entry.agentSlug === collab.lead_slug)) return
      const next = active[0]?.agentSlug ?? null
      if (next === collab.lead_slug) return
      yield* db
        .update(CollabTable)
        .set({ lead_slug: next })
        .where(eq(CollabTable.id, collabId))
        .run()
        .pipe(Effect.orDie)
    })

    const addParticipants = Effect.fn("Collab.addParticipants")(function* (
      collabId: string,
      agentSlugs: readonly string[],
    ) {
      const unique = [...new Set(agentSlugs)]
      if (unique.length === 0) return
      // Stamp join order explicitly: a bulk add lands inside one millisecond,
      // and `participants()` tiebreaks equal times ALPHABETICALLY — which made
      // the lead default (first joined) fall on the alphabetically-first slug
      // instead of the first invited. +i per row keeps invite order the truth.
      const base = Date.now()
      yield* db
        .insert(CollabParticipantTable)
        .values(unique.map((agent_slug, i) => ({ collab_id: collabId, agent_slug, time_added: base + i })))
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* syncLead(collabId)
    })

    const create = Effect.fn("Collab.create")(function* (input: {
      title: string
      agentSlugs: readonly string[]
      objective?: string
    }) {
      const id = Identifier.create("clb", "ascending")
      const row = yield* db
        .insert(CollabTable)
        .values({ id, title: input.title, ...(input.objective !== undefined ? { objective: input.objective } : {}) })
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error(`collab insert returned no row: ${id}`))
      yield* addParticipants(id, input.agentSlugs)
      // Re-read: the roster write promoted the first agent to lead, and the row
      // the insert answered with predates that.
      return collabOf((yield* load(id)) ?? row)
    })

    const list = Effect.fn("Collab.list")(function* () {
      const rows = yield* db.select().from(CollabTable).orderBy(desc(CollabTable.time_created)).all().pipe(Effect.orDie)
      return rows.map(collabOf)
    })

    const get = Effect.fn("Collab.get")(function* (collabId: string) {
      const row = yield* load(collabId)
      return row ? collabOf(row) : undefined
    })

    const archive = Effect.fn("Collab.archive")(function* (collabId: string, time?: number) {
      yield* db
        .update(CollabTable)
        .set({ time_archived: time ?? Date.now() })
        .where(eq(CollabTable.id, collabId))
        .run()
        .pipe(Effect.orDie)
    })

    /**
     * Reopen an archived collab. Only `time_archived` moves: the log, the roster,
     * every member's session and every last-seen marker are left exactly as the
     * archive found them, so the room comes back where it stopped rather than
     * replaying itself.
     */
    const unarchive = Effect.fn("Collab.unarchive")(function* (collabId: string) {
      yield* db
        .update(CollabTable)
        .set({ time_archived: null })
        .where(eq(CollabTable.id, collabId))
        .run()
        .pipe(Effect.orDie)
    })

    const rename = Effect.fn("Collab.rename")(function* (collabId: string, title: string) {
      yield* db.update(CollabTable).set({ title }).where(eq(CollabTable.id, collabId)).run().pipe(Effect.orDie)
    })

    /**
     * Add one agent, or bring a removed one back by clearing `time_removed`.
     *
     * A re-add keeps `session_id` and `last_seen_seq` on purpose: the agent
     * comes back with the memory it left with, and is not handed the whole
     * backlog of the conversation it was absent for as one turn.
     */
    const addParticipant = Effect.fn("Collab.addParticipant")(function* (collabId: string, agentSlug: string) {
      yield* db
        .insert(CollabParticipantTable)
        .values({ collab_id: collabId, agent_slug: agentSlug })
        .onConflictDoUpdate({
          target: [CollabParticipantTable.collab_id, CollabParticipantTable.agent_slug],
          set: { time_removed: null },
        })
        .run()
        .pipe(Effect.orDie)
      yield* syncLead(collabId)
    })

    /**
     * Soft delete: the roster row stays, so the agent's session, its last-seen
     * marker and everything it said are all still there if it is added back.
     */
    const removeParticipant = Effect.fn("Collab.removeParticipant")(function* (
      collabId: string,
      agentSlug: string,
      time?: number,
    ) {
      yield* db
        .update(CollabParticipantTable)
        .set({ time_removed: time ?? Date.now() })
        .where(and(eq(CollabParticipantTable.collab_id, collabId), eq(CollabParticipantTable.agent_slug, agentSlug)))
        .run()
        .pipe(Effect.orDie)
      yield* syncLead(collabId)
    })

    const setCap = Effect.fn("Collab.setCap")(function* (collabId: string, cap: number | null) {
      yield* db
        .update(CollabTable)
        .set({ loop_breaker_cap: cap })
        .where(eq(CollabTable.id, collabId))
        .run()
        .pipe(Effect.orDie)
    })

    /**
     * How many turns this room may dispatch at once. Written RAW: the width a
     * value means is `CollabParallel.dispatchWidth`'s answer, and clamping on
     * the way in would make "4 on a build that allowed 4" indistinguishable
     * from "8, clamped" the next time the ceiling moves.
     */
    const setConcurrency = Effect.fn("Collab.setConcurrency")(function* (collabId: string, concurrency: number | null) {
      yield* db.update(CollabTable).set({ concurrency }).where(eq(CollabTable.id, collabId)).run().pipe(Effect.orDie)
    })

    /**
     * What kind of room this is. Written RAW for the same reason the width is:
     * the meaning of a stored value is `CollabCouncil.flavorOf`'s answer, and
     * normalising on the way in would lose a flavor this build does not know
     * but a newer one does.
     */
    const setFlavor = Effect.fn("Collab.setFlavor")(function* (collabId: string, flavor: string | null) {
      yield* db.update(CollabTable).set({ flavor }).where(eq(CollabTable.id, collabId)).run().pipe(Effect.orDie)
    })

    const setLead = Effect.fn("Collab.setLead")(function* (collabId: string, agentSlug: string | null) {
      yield* db
        .update(CollabTable)
        .set({ lead_slug: agentSlug })
        .where(eq(CollabTable.id, collabId))
        .run()
        .pipe(Effect.orDie)
    })

    const setObjective = Effect.fn("Collab.setObjective")(function* (collabId: string, objective: string) {
      yield* db.update(CollabTable).set({ objective }).where(eq(CollabTable.id, collabId)).run().pipe(Effect.orDie)
    })

    const participants = Effect.fn("Collab.participants")(function* (collabId: string) {
      const rows = yield* db
        .select()
        .from(CollabParticipantTable)
        .where(eq(CollabParticipantTable.collab_id, collabId))
        .orderBy(asc(CollabParticipantTable.time_added), asc(CollabParticipantTable.agent_slug))
        .all()
        .pipe(Effect.orDie)
      return rows.map(participantOf)
    })

    const setParticipantSession = Effect.fn("Collab.setParticipantSession")(function* (
      collabId: string,
      agentSlug: string,
      sessionId: string,
    ) {
      yield* db
        .update(CollabParticipantTable)
        .set({ session_id: sessionId })
        .where(
          and(
            eq(CollabParticipantTable.collab_id, collabId),
            eq(CollabParticipantTable.agent_slug, agentSlug),
            isNull(CollabParticipantTable.session_id),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const setLastSeen = Effect.fn("Collab.setLastSeen")(function* (collabId: string, agentSlug: string, seq: number) {
      // Guarded by `<` so a late drain cannot rewind the marker and re-show an
      // agent messages it has already been given.
      yield* db
        .update(CollabParticipantTable)
        .set({ last_seen_seq: seq })
        .where(
          and(
            eq(CollabParticipantTable.collab_id, collabId),
            eq(CollabParticipantTable.agent_slug, agentSlug),
            lt(CollabParticipantTable.last_seen_seq, seq),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    /**
     * Append one message, assigning `seq = max(seq) + 1` INSIDE a transaction.
     * The unique (collab_id, seq) index is the backstop: two writers that read
     * the same max under separate connections make the loser fail there rather
     * than silently duplicating a sequence number, so it retries once with the
     * max it can now see.
     */
    const insert = (input: AppendInput) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const previous = yield* tx
            .select({ seq: CollabMessageTable.seq })
            .from(CollabMessageTable)
            .where(eq(CollabMessageTable.collab_id, input.collabId))
            .orderBy(desc(CollabMessageTable.seq))
            .limit(1)
            .get()
          const row = yield* tx
            .insert(CollabMessageTable)
            .values({
              id: Identifier.create("clbm", "ascending"),
              collab_id: input.collabId,
              seq: (previous?.seq ?? 0) + 1,
              author_id: input.authorId,
              author_kind: input.authorKind,
              kind: input.kind ?? "say",
              text: input.text,
              ...(input.replyToSeq !== undefined ? { reply_to_seq: input.replyToSeq } : {}),
              // An empty address list is stored as NULL, the column's own way of
              // saying "addressed to nobody in particular".
              ...(input.mentions && input.mentions.length > 0 ? { mentions: [...input.mentions] } : {}),
              ...(input.taskId !== undefined ? { task_id: input.taskId } : {}),
              ...(input.trace !== undefined ? { trace: boundTrace(input.trace) } : {}),
              // An empty list is stored as NULL, the same way an empty address
              // list is: "no images" is the column having no value.
              ...(input.images && input.images.length > 0 ? { images: [...input.images] } : {}),
            })
            .returning()
            .get()
          if (!row) return yield* Effect.die(new Error(`collab message insert returned no row: ${input.collabId}`))
          return messageOf(row)
        }),
      )

    const appendMessage = Effect.fn("Collab.appendMessage")(function* (input: AppendInput) {
      return yield* insert(input).pipe(
        Effect.catch(() => insert(input)),
        Effect.orDie,
      )
    })

    const listMessages = Effect.fn("Collab.listMessages")(function* (collabId: string, sinceSeq?: number) {
      const rows = yield* db
        .select()
        .from(CollabMessageTable)
        .where(
          sinceSeq === undefined
            ? eq(CollabMessageTable.collab_id, collabId)
            : and(eq(CollabMessageTable.collab_id, collabId), gt(CollabMessageTable.seq, sinceSeq)),
        )
        .orderBy(asc(CollabMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      return rows.map(messageOf)
    })

    const getTask = Effect.fn("Collab.getTask")(function* (collabId: string, taskId: string) {
      const row = yield* db
        .select()
        .from(CollabTaskTable)
        .where(and(eq(CollabTaskTable.collab_id, collabId), eq(CollabTaskTable.id, taskId)))
        .get()
        .pipe(Effect.orDie)
      return row ? taskOf(row) : undefined
    })

    const addTask = Effect.fn("Collab.addTask")(function* (input: TaskInput) {
      const row = yield* db
        .insert(CollabTaskTable)
        .values({
          id: Identifier.create("clbt", "ascending"),
          collab_id: input.collabId,
          title: input.title,
          state: input.state ?? "open",
          created_by: input.createdBy,
          ...(input.owner !== undefined ? { owner_slug: input.owner } : {}),
          ...(input.originSeq !== undefined ? { origin_seq: input.originSeq } : {}),
        })
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error(`collab task insert returned no row: ${input.collabId}`))
      return taskOf(row)
    })

    const setTaskOrigin = Effect.fn("Collab.setTaskOrigin")(function* (collabId: string, taskId: string, seq: number) {
      // Guarded by `isNull` so the origin can only be set once: it names the
      // message the task was born on, and a later write would repoint the
      // board row at a message that did not create it.
      yield* db
        .update(CollabTaskTable)
        .set({ origin_seq: seq })
        .where(
          and(
            eq(CollabTaskTable.collab_id, collabId),
            eq(CollabTaskTable.id, taskId),
            isNull(CollabTaskTable.origin_seq),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const updateTask = Effect.fn("Collab.updateTask")(function* (input: TaskUpdate) {
      const task = yield* getTask(input.collabId, input.taskId)
      if (!task) return yield* Effect.die(new Error(`collab task not found: ${input.taskId}`))
      // A refusal HERE means a caller skipped the check it owed the human, so
      // it is a defect rather than a value: the board must never end up in a
      // state no transition produced.
      const refusal = taskRefusal(task, input)
      if (refusal) return yield* Effect.die(new Error(`collab task ${input.taskId}: ${refusal}`))

      const changes: Partial<typeof CollabTaskTable.$inferInsert> = { state: TASK_NEXT[input.action] }
      // A reopen deliberately leaves `owner_slug` alone: the same agent is on
      // the hook again, which is what "same owner" in the transition means.
      if (input.action === "claim" && input.owner !== undefined) changes.owner_slug = input.owner
      if (input.action === "done" && input.result !== undefined) changes.result = input.result
      if (input.action === "reopen" && input.note !== undefined) changes.note = input.note

      const row = yield* db
        .update(CollabTaskTable)
        .set(changes)
        .where(and(eq(CollabTaskTable.collab_id, input.collabId), eq(CollabTaskTable.id, input.taskId)))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error(`collab task update returned no row: ${input.taskId}`))
      return taskOf(row)
    })

    const listTasks = Effect.fn("Collab.listTasks")(function* (collabId: string) {
      const rows = yield* db
        .select()
        .from(CollabTaskTable)
        .where(eq(CollabTaskTable.collab_id, collabId))
        .orderBy(asc(CollabTaskTable.time_created), asc(CollabTaskTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(taskOf)
    })

    const appendCost = Effect.fn("Collab.appendCost")(function* (input: LedgerInput) {
      const row = yield* db
        .insert(CollabTurnCostTable)
        .values({
          id: Identifier.create("clbc", "ascending"),
          collab_id: input.collabId,
          agent_slug: input.agentSlug,
          model: input.model,
          tokens_input: input.tokensInput,
          tokens_output: input.tokensOutput,
          cost: input.cost,
          ...(input.askedBy !== undefined ? { asked_by: input.askedBy } : {}),
        })
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error(`collab turn cost insert returned no row: ${input.collabId}`))
      return costOf(row)
    })

    const listCosts = Effect.fn("Collab.listCosts")(function* (collabId: string, limit = 100) {
      const rows = yield* db
        .select()
        .from(CollabTurnCostTable)
        .where(eq(CollabTurnCostTable.collab_id, collabId))
        // Id breaks the tie: two turns can finish inside the same millisecond,
        // and a ledger that reorders itself between two reads is unreadable.
        .orderBy(desc(CollabTurnCostTable.time_created), desc(CollabTurnCostTable.id))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return rows.map(costOf)
    })

    /** Summed in SQL rather than over `listCosts`, whose limit is a display one. */
    const costTotals = Effect.fn("Collab.costTotals")(function* (collabId: string) {
      const rows = yield* db
        .select({
          agentSlug: CollabTurnCostTable.agent_slug,
          cost: sql<number>`sum(${CollabTurnCostTable.cost})`,
          tokensInput: sql<number>`sum(${CollabTurnCostTable.tokens_input})`,
          tokensOutput: sql<number>`sum(${CollabTurnCostTable.tokens_output})`,
        })
        .from(CollabTurnCostTable)
        .where(eq(CollabTurnCostTable.collab_id, collabId))
        .groupBy(CollabTurnCostTable.agent_slug)
        .orderBy(asc(CollabTurnCostTable.agent_slug))
        .all()
        .pipe(Effect.orDie)
      return rows.map(
        (row): CostTotal => ({
          agentSlug: row.agentSlug,
          cost: row.cost,
          tokensInput: row.tokensInput,
          tokensOutput: row.tokensOutput,
        }),
      )
    })

    return Service.of({
      create,
      list,
      get,
      archive,
      unarchive,
      rename,
      setCap,
      setConcurrency,
      setFlavor,
      setLead,
      setObjective,
      addParticipants,
      addParticipant,
      removeParticipant,
      participants,
      setParticipantSession,
      setLastSeen,
      appendMessage,
      listMessages,
      addTask,
      setTaskOrigin,
      updateTask,
      getTask,
      listTasks,
      appendCost,
      listCosts,
      costTotals,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export * as CollabStore from "./store"
