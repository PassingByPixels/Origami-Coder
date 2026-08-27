import { Effect, Exit } from "effect"
import { Agent } from "@/agent/agent"
import { AgentBot } from "@/agent/bot"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import * as ACPError from "@/acp/error"
import { CollabActivity } from "./activity"
import { CollabCouncil } from "./council"
import { CollabParallel } from "./parallel"
import { CollabRules } from "./rules"
import { CollabSeal } from "./seal"
import { CollabRunner } from "./runner"
import { CollabStore } from "./store"

/**
 * The Collab ext methods (`collab_agents`, `collab_list`, `collab_create`,
 * `collab_post`, `collab_preview`, `collab_state`, `collab_set_cap`,
 * `collab_set_concurrency`, `collab_set_lead`, `collab_set_objective`, `collab_task_add`,
 * `collab_task_update`, `collab_review`, `collab_ledger`, `collab_stop`,
 * `collab_stop_agent`, `collab_redirect`, `collab_archive`,
 * `collab_unarchive`, `collab_rename`, `collab_add_participant`,
 * `collab_remove_participant`).
 *
 * `collab_state` is deliberately the ONLY read a shell needs after any write:
 * message log, roster, per-agent turn status and the loop-breaker verdict all
 * arrive together, so a UI can never render a roster from one moment against a
 * log from another.
 *
 * There is deliberately NO method for creating or editing an agent DEFINITION.
 * Definitions are files and the extension edits them directly on the global
 * agent directory.
 *
 * The methods that READ the roster of definitions - `collab_agents`,
 * `collab_create` and `collab_add_participant` - re-scan that directory first
 * (`Agent.rescan`), so a definition written a moment ago is usable NOW rather
 * than on the next engine start. `Agent.rescan` documents the narrow cases that
 * still need a restart, the main one being a DELETED definition file.
 */

export type AgentEntry = {
  readonly slug: string
  readonly displayName: string
  /** The definition's pinned `provider/model`, or null when it pins nothing. */
  readonly model: string | null
  /**
   * THE BOT CONTRACT, as declared. Every field below is OMITTED when the
   * definition said nothing, so a shell can tell "the author chose this" from
   * "the author left the default" - which is the difference between rendering a
   * selected tier and rendering an empty control. Omission is the default, not
   * a value: adding a field with its default here would make every definition
   * look configured.
   */
  readonly permissions?: AgentBot.PermissionTier
  /** A `permissions:` value this build does not know. Present = show the typo. */
  readonly unknownPermissions?: string
  /** Skills this bot may load. Absent = every skill; `[]` = none. */
  readonly skills?: readonly string[]
  /** Present only as `false` — a bot that opted out of its own memory. */
  readonly memory?: false
}

export type CollabEntry = {
  readonly id: string
  readonly title: string
  /** ISO string on the wire - the package convention for *At fields. */
  readonly createdAt: string
  readonly archivedAt?: string
  readonly loopBreakerCap: number | null
  /** Who an unaddressed human message reaches. null = nobody. */
  readonly lead: string | null
  readonly objective: string | null
  /**
   * How many participant turns this room dispatches at once. null = never
   * configured, which is SERIAL - the shape every room shipped with. Sent as
   * null rather than 1 so a shell can tell "left alone" from "set to one".
   */
  readonly concurrency: number | null
  /**
   * What KIND of room this is, RESOLVED - never the raw stored value.
   *
   * Unlike `concurrency` there is no "never configured" state worth telling a
   * shell about: an unset flavor and `discuss` are the same room, and the rule
   * that resolves anything unrecognised to `discuss` is a safety rule
   * (`CollabCouncil.flavorOf`) that no shell should have to re-implement.
   */
  readonly flavor: CollabCouncil.Flavor
}

export type ParticipantEntry = {
  readonly agentSlug: string
  readonly displayName: string
  readonly model: string | null
  /**
   * The agent's own child session, once it has taken a turn. Omitted - never
   * null - while it has not, so a shell can test presence rather than value.
   */
  readonly sessionId?: string
  readonly removedAt?: string
}

export type MessageEntry = {
  readonly id: string
  readonly seq: number
  readonly authorId: string
  readonly authorKind: "human" | "agent"
  /** What the entry IS. Routing reads this, never the prose. */
  readonly kind: CollabStore.MessageKind
  readonly text: string
  readonly replyToSeq: number | null
  readonly mentions: readonly string[]
  readonly taskId: string | null
  readonly trace: readonly CollabStore.TraceEntry[] | null
  /**
   * The images the human posted with this message, as `data:` URLs. OMITTED
   * when there are none, so a shell tests presence rather than length - the
   * ordinary message carries no key at all.
   */
  readonly images?: readonly string[]
  /** ISO string on the wire - the package convention for *At fields. */
  readonly createdAt: string
}

export type TaskEntry = {
  readonly id: string
  readonly title: string
  readonly owner: string | null
  readonly state: CollabStore.TaskState
  readonly createdBy: string
  readonly result: string | null
  readonly note: string | null
  readonly originSeq: number | null
  /** ISO strings on the wire - the package convention for *At fields. */
  readonly createdAt: string
  readonly updatedAt: string
}

export type LedgerEntry = {
  readonly id: string
  readonly agentSlug: string
  readonly model: string
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly cost: number
  readonly askedBy: string | null
  /** ISO string on the wire - the package convention for *At fields. */
  readonly createdAt: string
}

export type CostTotalEntry = {
  readonly agentSlug: string
  readonly cost: number
  readonly tokensInput: number
  readonly tokensOutput: number
}

/** What is left of the hop budget this human message bought. */
export type HopState = CollabRunner.HopState

export type AgentStatusEntry = {
  readonly slug: string
  readonly state: CollabRunner.AgentState
  readonly lastError?: string
  /** Present only while this agent's turn is RUNNING. Absent, never stale. */
  readonly liveActivity?: CollabRunner.LiveActivity
  /**
   * The whole reasoning of the turn in flight, for a shell that renders it as
   * an expanding block. Present on the same terms as `liveActivity` - only
   * while the turn runs, absent rather than stale - and bounded server-side at
   * {@link CollabRunner.LIVE_THOUGHT_MAX_CHARS}, so a shell never has to guess
   * how much of it is safe to hold.
   */
  readonly liveThought?: string
  /**
   * The last few things this agent did or thought, oldest first, kept ACROSS
   * turns - see {@link CollabRunner.Interface.activityLog}. Omitted, never
   * empty, so a shell tests presence.
   *
   * Present for an idle agent too, which is the point: `liveActivity` answers
   * "what is it doing", and a room whose agents are between turns answers that
   * with nothing at all.
   */
  readonly activity?: readonly CollabActivity.ActivityEntry[]
}

export type State = {
  readonly collab: CollabEntry
  readonly participants: readonly ParticipantEntry[]
  readonly messages: readonly MessageEntry[]
  readonly agents: readonly AgentStatusEntry[]
  readonly lead: string | null
  readonly objective: string | null
  readonly tasks: readonly TaskEntry[]
  readonly costTotals: readonly CostTotalEntry[]
  readonly hopState: HopState
  /** Hop budget spent: autonomous replies are held until a human posts. */
  readonly suspended: boolean
}

/** What `collab_post` answers with. `notice` explains a post nobody received. */
export type PostResult = {
  readonly seq: number
  readonly notice?: "no-lead"
}

/**
 * What `collab_preview` answers with: who a draft WOULD wake, before it is
 * sent. Token-free - the wake rules read a message's kind and its address list,
 * never its prose, which is exactly why this can be evaluated live.
 */
export type PreviewResult = {
  /** The slugs that would take a turn, in roster order. */
  readonly wake: readonly string[]
  /** Same meaning as on {@link PostResult}: the draft would reach nobody. */
  readonly notice?: "no-lead"
  /**
   * Addresses that are not on the active roster. Omitted when there are none.
   * `collab_post` REFUSES such a draft, so answering a bare empty wake set
   * would be describing a message that never gets sent.
   */
  readonly unknown?: readonly string[]
}

/** The human's verdict on a task an agent completed. */
export type Verdict = "approve" | "reject"

export type Interface = {
  readonly agents: (directory: string) => Effect.Effect<{ agents: readonly AgentEntry[] }, ACPError.Error>
  readonly list: (directory: string) => Effect.Effect<{ collabs: readonly CollabEntry[] }, ACPError.Error>
  readonly create: (
    directory: string,
    input: { title: string; agentSlugs: readonly string[]; objective?: string },
  ) => Effect.Effect<{ collab: CollabEntry }, ACPError.Error>
  readonly post: (
    directory: string,
    input: { collabId: string; text: string; mentions?: readonly string[]; images?: readonly string[] },
  ) => Effect.Effect<PostResult, ACPError.Error>
  readonly preview: (
    directory: string,
    input: { collabId: string; mentions?: readonly string[] },
  ) => Effect.Effect<PreviewResult, ACPError.Error>
  readonly state: (
    directory: string,
    input: { collabId: string; sinceSeq?: number },
  ) => Effect.Effect<State, ACPError.Error>
  readonly setCap: (
    directory: string,
    input: { collabId: string; cap: number | null },
  ) => Effect.Effect<{ ok: true }, ACPError.Error>
  /** Raising is gated on every member being read-only for files; lowering is not. */
  readonly setConcurrency: (
    directory: string,
    input: { collabId: string; concurrency: number },
  ) => Effect.Effect<{ ok: true }, ACPError.Error>
  /** Becoming a council is gated exactly as raising the width is; leaving is not. */
  readonly setFlavor: (
    directory: string,
    input: { collabId: string; flavor: string },
  ) => Effect.Effect<{ ok: true }, ACPError.Error>
  readonly setLead: (
    directory: string,
    input: { collabId: string; agentSlug: string | null },
  ) => Effect.Effect<{ ok: true }, ACPError.Error>
  readonly setObjective: (
    directory: string,
    input: { collabId: string; objective: string },
  ) => Effect.Effect<{ ok: true }, ACPError.Error>
  readonly taskAdd: (
    directory: string,
    input: { collabId: string; title: string },
  ) => Effect.Effect<{ task: TaskEntry }, ACPError.Error>
  readonly taskUpdate: (
    directory: string,
    input: {
      collabId: string
      taskId: string
      action: CollabStore.TaskAction
      result?: string
      note?: string
      owner?: string
    },
  ) => Effect.Effect<{ task: TaskEntry }, ACPError.Error>
  readonly review: (
    directory: string,
    input: { collabId: string; taskId: string; verdict: Verdict; note?: string },
  ) => Effect.Effect<{ task: TaskEntry }, ACPError.Error>
  readonly ledger: (
    directory: string,
    input: { collabId: string; limit?: number },
  ) => Effect.Effect<{ entries: readonly LedgerEntry[]; totals: readonly CostTotalEntry[] }, ACPError.Error>
  readonly stop: (directory: string, input: { collabId: string }) => Effect.Effect<{ ok: true }, ACPError.Error>
  readonly stopAgent: (
    directory: string,
    input: { collabId: string; agentSlug: string },
  ) => Effect.Effect<CollabRunner.StopAgentResult, ACPError.Error>
  readonly redirect: (
    directory: string,
    input: { collabId: string; agentSlug: string; text: string },
  ) => Effect.Effect<{ seq: number }, ACPError.Error>
  readonly archive: (directory: string, input: { collabId: string }) => Effect.Effect<{ ok: true }, ACPError.Error>
  readonly unarchive: (directory: string, input: { collabId: string }) => Effect.Effect<{ ok: true }, ACPError.Error>
  readonly rename: (
    directory: string,
    input: { collabId: string; title: string },
  ) => Effect.Effect<{ ok: true }, ACPError.Error>
  readonly addParticipant: (
    directory: string,
    input: { collabId: string; agentSlug: string },
  ) => Effect.Effect<{ ok: true }, ACPError.Error>
  readonly removeParticipant: (
    directory: string,
    input: { collabId: string; agentSlug: string },
  ) => Effect.Effect<{ ok: true }, ACPError.Error>
}

/** An agent definition opted into Collabs with `collab:` frontmatter. */
export function collabCapable(info: Agent.Info): boolean {
  return Boolean(info.options["collab"])
}

export function modelOf(info: Agent.Info): string | null {
  return info.model ? `${info.model.providerID}/${info.model.modelID}` : null
}

export function agentEntry(info: Agent.Info): AgentEntry {
  const contract = AgentBot.read(info.options)
  return {
    slug: info.name,
    displayName: info.description ?? info.name,
    model: modelOf(info),
    ...(contract.tier ? { permissions: contract.tier } : {}),
    ...(contract.unknownTier ? { unknownPermissions: contract.unknownTier } : {}),
    ...(contract.skills ? { skills: contract.skills } : {}),
    ...(contract.memory ? {} : { memory: false as const }),
  }
}

const iso = (epochMs: number) => new Date(epochMs).toISOString()

export function collabEntry(collab: CollabStore.Collab): CollabEntry {
  return {
    id: collab.id,
    title: collab.title,
    createdAt: iso(collab.createdAt),
    ...(collab.archivedAt !== undefined ? { archivedAt: iso(collab.archivedAt) } : {}),
    loopBreakerCap: collab.loopBreakerCap,
    lead: collab.lead,
    objective: collab.objective,
    concurrency: collab.concurrency,
    flavor: CollabCouncil.flavorOf(collab.flavor),
  }
}

/**
 * One roster row for the wire. `info` is undefined when no definition backs the
 * slug any more - the row still ships, because the log still has its messages.
 */
export function participantEntry(entry: CollabStore.Participant, info: Agent.Info | undefined): ParticipantEntry {
  return {
    agentSlug: entry.agentSlug,
    displayName: info?.description ?? entry.agentSlug,
    model: info ? modelOf(info) : null,
    ...(entry.sessionId !== null ? { sessionId: entry.sessionId } : {}),
    ...(entry.removedAt !== undefined ? { removedAt: iso(entry.removedAt) } : {}),
  }
}

export function messageEntry(message: CollabStore.Message): MessageEntry {
  return {
    id: message.id,
    seq: message.seq,
    authorId: message.authorId,
    authorKind: message.authorKind,
    kind: message.kind,
    replyToSeq: message.replyToSeq ?? null,
    text: message.text,
    mentions: message.mentions,
    taskId: message.taskId,
    trace: message.trace,
    ...(message.images !== undefined ? { images: message.images } : {}),
    createdAt: iso(message.createdAt),
  }
}

export function taskEntry(task: CollabStore.Task): TaskEntry {
  return {
    id: task.id,
    title: task.title,
    owner: task.owner,
    state: task.state,
    createdBy: task.createdBy,
    result: task.result,
    note: task.note,
    originSeq: task.originSeq,
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
  }
}

export function ledgerEntry(entry: CollabStore.LedgerEntry): LedgerEntry {
  return {
    id: entry.id,
    agentSlug: entry.agentSlug,
    model: entry.model,
    tokensInput: entry.tokensInput,
    tokensOutput: entry.tokensOutput,
    cost: entry.cost,
    askedBy: entry.askedBy,
    createdAt: iso(entry.createdAt),
  }
}

/** How much of the board one `collab_state` carries. */
export const TASK_BOARD_LIMIT = 50

/**
 * Board order: everything still in play first, accepted work last, and only
 * the first {@link TASK_BOARD_LIMIT}. The sort is stable, so inside each group
 * the store's creation order survives - a board that reshuffled itself between
 * two polls would be unreadable.
 */
export function taskBoard(tasks: readonly CollabStore.Task[]): TaskEntry[] {
  return tasks
    .toSorted((left, right) => Number(left.state === "accepted") - Number(right.state === "accepted"))
    .slice(0, TASK_BOARD_LIMIT)
    .map(taskEntry)
}

/**
 * Whether the room is waiting on a human: the hop budget this message bought
 * is spent, so nothing autonomous is scheduled until the next human post.
 */
export function suspended(hops: HopState): boolean {
  return hops.remaining !== null && hops.remaining <= 0
}

/** The room message one task board action leaves behind. */
const TASK_MESSAGE: Record<CollabStore.TaskAction | "add", { kind: CollabStore.MessageKind; verb: string }> = {
  add: { kind: "task_open", verb: "opened" },
  claim: { kind: "task_claim", verb: "claimed" },
  done: { kind: "task_done", verb: "completed" },
  accept: { kind: "task_accept", verb: "accepted" },
  reopen: { kind: "task_reopen", verb: "reopened" },
}

/**
 * Every "no" this module gives.
 *
 * A REFUSAL, never a service failure. Each message below is a finished sentence
 * written for the person at the controls - which slug is not in the room, which
 * flavors exist, what a cap may be - and `ACPServiceFailureError` maps onto the
 * JSON-RPC INTERNAL error, so the client rendered `Internal error: ` in front of
 * every one of them. Nothing in the engine is broken when a room declines a
 * setting, and telling the user otherwise sent them looking for a bug.
 */
const failed = (message: string) => new ACPError.RefusalError({ safeMessage: message, service: "collab" })

/**
 * Why one slug cannot join. Always called AFTER a rescan, so "no definition
 * file" means exactly that rather than "the engine started before you wrote
 * it". Naming the FILE is the point: the two failures a human can actually fix
 * are a missing `collab: true` and frontmatter that does not parse, and neither
 * is findable from the slug alone.
 */
const rejection = Effect.fnUntraced(function* (slug: string) {
  const file = yield* (yield* Agent.Service).definitionFile(slug)
  return file
    ? `${slug} is not a collab-capable agent: ${file} must set \`collab: true\`, and its frontmatter must parse`
    : `${slug} is not a collab-capable agent: no definition file for it in any config directory`
})

/**
 * Runs against the process-wide AppRuntime, which already provides the store,
 * the agent registry and the session services. Building a private layer stack
 * would stand up a SECOND Database/Config instance and deadlock against the
 * live one - the same rule `Flock.state` and `Skills.list` follow.
 */
const inInstance = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const context = yield* store.load({ directory })
    return yield* self.pipe(Effect.provideService(InstanceRef, context))
  })

/** Resolve a collab, or fail with the message the extension host surfaces. */
const loadCollab = Effect.fnUntraced(function* (collabId: string) {
  const collab = yield* (yield* CollabStore.Service).get(collabId)
  if (!collab) return yield* failed(`collab not found: ${collabId}`)
  return collab
})

const bindContext = Effect.fnUntraced(function* (collabId: string) {
  yield* (yield* CollabRunner.Service).bind(collabId, yield* InstanceRef)
})

/** The slugs still in the room, in join order. The only addressable set. */
const activeRoster = Effect.fnUntraced(function* (collabId: string) {
  const roster = yield* (yield* CollabStore.Service).participants(collabId)
  return roster.filter((entry) => entry.removedAt === undefined).map((entry) => entry.agentSlug)
})

/**
 * The slug must still be in the room. Every PER-AGENT method refuses the same
 * way and names the roster, because a shell cannot fix an address it is not
 * told the alternatives to.
 */
const requireMember = Effect.fnUntraced(function* (collabId: string, agentSlug: string) {
  const active = yield* activeRoster(collabId)
  if (!active.includes(agentSlug)) {
    return yield* failed(`not in this collab: ${agentSlug} — on the roster: ${active.join(", ")}`)
  }
})

/** A task the caller named, or the message the extension host surfaces. */
const loadTask = Effect.fnUntraced(function* (collabId: string, taskId: string) {
  const task = yield* (yield* CollabStore.Service).getTask(collabId, taskId)
  if (!task) return yield* failed(`task not found: ${taskId}`)
  return task
})

/**
 * One board move plus the room row that reports it: the single place a task
 * transition is written, so a human's verdict and an ordinary board call can
 * never drift apart.
 *
 * The row carries the NOTE when the move has one. Without it the agent this
 * wakes reads "reopened task: X" and learns only that somebody was unhappy,
 * not what has to change.
 */
const applyTaskMove = Effect.fnUntraced(function* (
  collab: CollabStore.Collab,
  input: {
    taskId: string
    action: CollabStore.TaskAction
    result?: string
    note?: string
    owner?: string
  },
) {
  const task = yield* loadTask(collab.id, input.taskId)
  const refusal = CollabStore.taskRefusal(task, input)
  if (refusal) return yield* failed(refusal)

  const updated = yield* (yield* CollabStore.Service).updateTask({ ...input, collabId: collab.id })
  const entry = TASK_MESSAGE[input.action]
  yield* bindContext(collab.id)
  yield* (yield* CollabRunner.Service).post({
    collabId: collab.id,
    kind: entry.kind,
    text: `${entry.verb} task: ${updated.title}${input.note ? ` — ${input.note}` : ""}`,
    taskId: updated.id,
  })
  return updated
})

export const agents = Effect.fn("ACPCollab.agents")(function* (directory: string) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const registry = yield* Agent.Service
      // EVERY call, not once: the extension writes a definition file and lists
      // straight afterwards, and a list that could not show what was just
      // written would be telling the user to restart the engine.
      yield* registry.rescan()
      const all = yield* registry.list()
      return {
        agents: all
          .filter(collabCapable)
          .map(agentEntry)
          .toSorted((left, right) => left.slug.localeCompare(right.slug)),
      }
    }),
  )
})

export const list = Effect.fn("ACPCollab.list")(function* (directory: string) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const store = yield* CollabStore.Service
      return { collabs: (yield* store.list()).map(collabEntry) }
    }),
  )
})

export const create = Effect.fn("ACPCollab.create")(function* (
  directory: string,
  input: { title: string; agentSlugs: readonly string[]; objective?: string },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const registry = yield* Agent.Service
      // Re-scan FIRST, so a definition written since the engine started can be
      // invited. Without it the only cure is an engine restart.
      yield* registry.rescan()
      const capable = new Set((yield* registry.list()).filter(collabCapable).map((info) => info.name))
      // Fail-closed on a slug that is unknown even after the re-scan: a roster
      // entry no definition backs can never take a turn, and a collab that
      // silently drops a member reads as that member ignoring everyone.
      const unknown = input.agentSlugs.filter((slug) => !capable.has(slug))
      if (unknown.length > 0) {
        return yield* failed((yield* Effect.forEach(unknown, rejection)).join("; "))
      }

      const store = yield* CollabStore.Service
      const objective = input.objective?.trim()
      const collab = yield* store.create({
        title: input.title,
        agentSlugs: input.agentSlugs,
        ...(objective ? { objective } : {}),
      })
      yield* bindContext(collab.id)
      return { collab: collabEntry(collab) }
    }),
  )
})

export const post = Effect.fn("ACPCollab.post")(function* (
  directory: string,
  input: { collabId: string; text: string; mentions?: readonly string[]; images?: readonly string[] },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      if (collab.archivedAt !== undefined) return yield* failed(`collab is archived: ${input.collabId}`)

      // Images are checked BEFORE anything is written, for the same reason
      // addressing is: half a post is worse than none. The refusal names the
      // limit, so the human can shrink or drop one and post again.
      const images = input.images ?? []
      if (images.length > 0) {
        const refusal = CollabStore.imageRefusal(images)
        if (refusal) return yield* failed(refusal)
      }

      // Addressing is checked BEFORE anything is written: a post addressed to a
      // slug that is not in the room would otherwise be recorded and then reach
      // nobody, which reads as every agent ignoring it.
      const mentions = input.mentions ?? []
      if (mentions.length > 0) {
        const active = yield* activeRoster(collab.id)
        const unknown = mentions.filter((slug) => !active.includes(slug))
        if (unknown.length > 0) {
          return yield* failed(`not in this collab: ${unknown.join(", ")} — on the roster: ${active.join(", ")}`)
        }
      }

      yield* bindContext(collab.id)
      // Returns as soon as the post is DURABLE. The turns it triggers run
      // detached: a shell that had to wait for every agent to answer could not
      // show the message it just sent.
      //
      // The validated `mentions` ride the row: routing reads that list and
      // never the prose, so "@crane" written inside a sentence is a reference
      // to a colleague rather than a summons.
      const message = yield* (yield* CollabRunner.Service).post({
        collabId: collab.id,
        text: input.text,
        ...(mentions.length > 0 ? { mentions } : {}),
        ...(images.length > 0 ? { images } : {}),
      })
      // An unaddressed post with no lead reaches no one. The post still stands
      // - it is the record of what was asked - but the shell is told, rather
      // than left watching a room that will never answer.
      const notice = mentions.length === 0 && collab.lead === null ? { notice: "no-lead" as const } : {}
      return { seq: message.seq, ...notice }
    }),
  )
})

/**
 * Who a draft WOULD wake - the C14 composer preview, evaluated live while the
 * human is still typing.
 *
 * Reads only. Nothing is bound, nothing is appended, no session is created and
 * no turn is scheduled: this must be safe to call on every keystroke, and a
 * preview that cost what sending costs would be worse than no preview.
 *
 * There is deliberately no `text` parameter. Routing is mechanical - the rules
 * read a message's kind and its address list and never its prose - so a draft's
 * words cannot change the answer, and accepting them here would imply they can.
 */
export const preview = Effect.fn("ACPCollab.preview")(function* (
  directory: string,
  input: { collabId: string; mentions?: readonly string[] },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      const active = yield* activeRoster(collab.id)
      const mentions = input.mentions ?? []
      const unknown = mentions.filter((slug) => !active.includes(slug))
      // The slug stands in for the display name: no rule reads one, and
      // resolving every definition first would put a directory scan on a
      // keystroke path.
      const wake = CollabRules.wakeSet({
        roster: active.map((agentSlug) => ({ agentSlug, displayName: agentSlug })),
        lead: collab.lead,
        mentions,
        // The preview runs the SAME stack the room fans out on, flavor
        // included: in a council an unaddressed draft wakes everybody, and a
        // preview that named the lead would teach a rule the room does not have.
        flavor: CollabCouncil.flavorOf(collab.flavor),
      })
      return {
        wake,
        // Read off the ANSWER rather than off the lead seat. A leadless COUNCIL
        // still wakes its whole roster, and telling that user "nobody would
        // answer" would be flatly wrong. In a discuss room an empty wake set is
        // exactly the old condition, so nothing there changes.
        ...(wake.length === 0 && mentions.length === 0 && collab.lead === null
          ? { notice: "no-lead" as const }
          : {}),
        ...(unknown.length > 0 ? { unknown } : {}),
      } satisfies PreviewResult
    }),
  )
})

export const state = Effect.fn("ACPCollab.state")(function* (
  directory: string,
  input: { collabId: string; sinceSeq?: number },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      const store = yield* CollabStore.Service
      const registry = yield* Agent.Service
      const runner = yield* CollabRunner.Service
      const roster = yield* store.participants(collab.id)
      const statuses = yield* runner.statuses(collab.id)
      const activity = yield* runner.liveActivity(collab.id)
      // AFTER `liveActivity`, never before: that call is the read that fills the
      // retained log, so taking it first would answer with the poll before this
      // one and leave the chip a whole cycle ahead of the history beside it.
      const kept = yield* runner.activityLog(collab.id)

      const participants: ParticipantEntry[] = []
      for (const entry of roster) {
        // A definition can be deleted while a collab still names it. Show the
        // slug rather than dropping the row: the log still has its messages.
        const info = yield* registry.get(entry.agentSlug).pipe(Effect.exit)
        participants.push(participantEntry(entry, Exit.isSuccess(info) ? info.value : undefined))
      }

      // Read from the runner's live budget, never derived from the log: the
      // hops a chain of asks spent leave no trailing agent messages to count.
      const hops = yield* runner.hopState(collab.id)

      return {
        collab: collabEntry(collab),
        participants,
        messages: (yield* store.listMessages(collab.id, input.sinceSeq)).map(messageEntry),
        agents: roster
          .filter((entry) => entry.removedAt === undefined)
          .map((entry) => {
            const status = statuses.get(entry.agentSlug)
            const live = activity.get(entry.agentSlug)
            const history = kept.get(entry.agentSlug)
            return {
              slug: entry.agentSlug,
              state: status?.state ?? "idle",
              ...(status?.lastError ? { lastError: status.lastError } : {}),
              ...(live?.activity ? { liveActivity: live.activity } : {}),
              ...(live?.thought ? { liveThought: live.thought } : {}),
              ...(history && history.length > 0 ? { activity: history } : {}),
            }
          }),
        lead: collab.lead,
        objective: collab.objective,
        tasks: taskBoard(yield* store.listTasks(collab.id)),
        costTotals: yield* store.costTotals(collab.id),
        hopState: hops,
        suspended: suspended(hops),
      } satisfies State
    }),
  )
})

export const setCap = Effect.fn("ACPCollab.setCap")(function* (
  directory: string,
  input: { collabId: string; cap: number | null },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      if (input.cap !== null && (!Number.isInteger(input.cap) || input.cap < 0)) {
        return yield* failed(`loop breaker cap must be null or a non-negative integer: ${input.cap}`)
      }
      yield* (yield* CollabStore.Service).setCap(collab.id, input.cap)
      return { ok: true as const }
    }),
  )
})

/**
 * How many participant turns this room may dispatch at once.
 *
 * THE GATE. Raising the width is the one room setting that can change what the
 * members are able to DO to the workspace, so it is refused unless every active
 * member's effective ruleset - its tier, its own `permission:` block and the
 * room seal composed exactly as `createSession` composes them - denies every
 * file-writing door. The reason is in `CollabParallel`'s header: worktree
 * isolation lives extension-side and cannot be composed into a room, so a
 * parallel room deliberates rather than builds.
 *
 * LOWERING IS NEVER GATED. The gate exists to stop parallel writers, not to
 * trap a room at a width it can no longer justify - a roster change that makes
 * a wide room unsafe must still be narrowable without editing definitions.
 */
export const setConcurrency = Effect.fn("ACPCollab.setConcurrency")(function* (
  directory: string,
  input: { collabId: string; concurrency: number },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      const width = input.concurrency
      if (!Number.isInteger(width) || width < 1 || width > CollabParallel.CONCURRENCY_MAX) {
        return yield* failed(`concurrency must be a whole number from 1 to ${CollabParallel.CONCURRENCY_MAX}: ${width}`)
      }
      if (width > 1) {
        const refusal = yield* parallelRefusal(collab.id)
        if (refusal) return yield* failed(refusal)
      }
      yield* (yield* CollabStore.Service).setConcurrency(collab.id, width)
      return { ok: true as const }
    }),
  )
})

/**
 * Why this room may NOT run turns side by side, or undefined when it may.
 *
 * The gate on an EXPLICIT concurrency raise, and on that alone. A raised width
 * is a room asking to run its ordinary turns in parallel, and an ordinary turn
 * is where a member is meant to build - so the only honest answers are "prove
 * every member is read-only" or "corrupt a file", and this is the first.
 *
 * The `council` flavor used to answer to the same gate and no longer does. A
 * council does not need its members to be read-only BOTS; it needs its round
 * turns to be read-only TURNS, and that is enforced where the turn runs
 * (`CollabSeal.COUNCIL_SEAL`) rather than by refusing the setting. Refusing it
 * put a paragraph about permission rulesets in front of a person who had only
 * asked three bots a question.
 */
const parallelRefusal = Effect.fnUntraced(function* (collabId: string) {
  const registry = yield* Agent.Service
  // The definitions as they are on disk NOW, for the same reason
  // `createSession` rescans: the answer must be about the files the next turn
  // will actually run, not the ones the engine booted on.
  yield* registry.rescan()
  const members: CollabParallel.Member[] = []
  for (const agentSlug of yield* activeRoster(collabId)) {
    const info = yield* registry.get(agentSlug).pipe(Effect.exit)
    // A slug with no definition left is not provably anything. It cannot take a
    // turn either, but a room that widened around a missing member would
    // silently widen again the moment the file came back.
    if (!Exit.isSuccess(info) || !info.value) {
      return `no agent definition for ${agentSlug} — it cannot be checked for parallel safety`
    }
    // The ruleset the child session ACTUALLY runs under: the definition's own,
    // then the session's, in the order session/tools.ts merges them
    // (`Permission.merge(agent.permission, live.permission)`). Checking either
    // half alone would answer about a session that never runs.
    members.push({
      agentSlug,
      permission: [
        ...info.value.permission,
        ...CollabSeal.sessionPermission({
          agentPermission: info.value.permission,
          sessionPermission: deriveSubagentSessionPermission({
            parentSessionPermission: [],
            subagent: info.value,
          }),
        }),
      ],
    })
  }
  return CollabParallel.concurrencyRefusal(members)
})

/**
 * What KIND of room this is: `discuss` (the chain every room has always run) or
 * `council` (one question to every member at once, blind, then a synthesis).
 *
 * NEVER GATED ON PERMISSIONS, in either direction. The only thing refused here
 * is a flavor this build does not have.
 *
 * It WAS gated, on the same write-safety rule a raised width answers to, and the
 * owner's verdict on that is the reason this method is now three lines: a person
 * who has built two bots and wants them to answer one question together should
 * turn council on and have it work. The hazard the gate named is real, and it is
 * answered on the turn instead of on the setting - every council ROUND turn runs
 * under `CollabSeal.COUNCIL_SEAL`, which shuts every file-writing door for the
 * length of that turn and gives it back for the room's discuss turns.
 */
export const setFlavor = Effect.fn("ACPCollab.setFlavor")(function* (
  directory: string,
  input: { collabId: string; flavor: string },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      if (input.flavor !== "discuss" && input.flavor !== "council") {
        return yield* failed(`unknown collab flavor: ${input.flavor} — it is one of discuss, council`)
      }
      yield* (yield* CollabStore.Service).setFlavor(collab.id, input.flavor)
      return { ok: true as const }
    }),
  )
})

/**
 * Name the agent an unaddressed human message goes to, or clear it with null.
 * Only an ACTIVE participant may hold the seat: a lead nobody can wake is the
 * same as no lead, but reads as a room that is simply ignoring you.
 */
export const setLead = Effect.fn("ACPCollab.setLead")(function* (
  directory: string,
  input: { collabId: string; agentSlug: string | null },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      if (input.agentSlug !== null) {
        const active = yield* activeRoster(collab.id)
        if (!active.includes(input.agentSlug)) {
          return yield* failed(`not in this collab: ${input.agentSlug} — on the roster: ${active.join(", ")}`)
        }
      }
      yield* (yield* CollabStore.Service).setLead(collab.id, input.agentSlug)
      return { ok: true as const }
    }),
  )
})

/** Set the standing goal every agent is reminded of on every turn. */
export const setObjective = Effect.fn("ACPCollab.setObjective")(function* (
  directory: string,
  input: { collabId: string; objective: string },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      yield* (yield* CollabStore.Service).setObjective(collab.id, input.objective.trim())
      return { ok: true as const }
    }),
  )
})

/**
 * Put one task on the board by hand.
 *
 * The matching room message goes through the RUNNER, so the wake rules see it.
 * They wake nobody for an opened task - that is bookkeeping, and a fan-out per
 * checkbox would spend a turn from every agent on news none of them has to act
 * on - but the SAME path has to carry a human completing or reopening an
 * agent's task, which does have exactly one agent to reach.
 */
export const taskAdd = Effect.fn("ACPCollab.taskAdd")(function* (
  directory: string,
  input: { collabId: string; title: string },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      if (collab.archivedAt !== undefined) return yield* failed(`collab is archived: ${input.collabId}`)
      const title = input.title.trim()
      if (title.length === 0) return yield* failed(`task title must not be empty: ${input.collabId}`)

      const store = yield* CollabStore.Service
      const task = yield* store.addTask({ collabId: collab.id, title, createdBy: "user" })
      const entry = TASK_MESSAGE.add
      yield* bindContext(collab.id)
      yield* (yield* CollabRunner.Service).post({
        collabId: collab.id,
        kind: entry.kind,
        text: `${entry.verb} task: ${title}`,
        taskId: task.id,
      })
      return { task: taskEntry(task) }
    }),
  )
})

/**
 * Move one task along the board. The legal moves are the store's table, read
 * here first so a refusal reaches the human as a message rather than a crash.
 */
export const taskUpdate = Effect.fn("ACPCollab.taskUpdate")(function* (
  directory: string,
  input: {
    collabId: string
    taskId: string
    action: CollabStore.TaskAction
    result?: string
    note?: string
    owner?: string
  },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      if (collab.archivedAt !== undefined) return yield* failed(`collab is archived: ${input.collabId}`)
      return { task: taskEntry(yield* applyTaskMove(collab, input)) }
    }),
  )
})

/**
 * The human's verdict on a task an agent completed: accept the work, or send it
 * back with the reason it is not done.
 *
 * NOT a second board vocabulary - it runs the SAME two transitions
 * `collab_task_update` runs, through the same helper. What it adds is a shape a
 * supervision surface can bind two buttons to without knowing that "reject" is
 * spelt `reopen`, and the note requirement that makes a rejection actionable.
 *
 * The legality gate is the board's own table rather than a rule invented here:
 * only a COMPLETED task can be accepted or reopened, so a verdict on anything
 * else is refused with the reason and the board is not touched.
 */
export const review = Effect.fn("ACPCollab.review")(function* (
  directory: string,
  input: { collabId: string; taskId: string; verdict: Verdict; note?: string },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      if (collab.archivedAt !== undefined) return yield* failed(`collab is archived: ${input.collabId}`)
      return {
        task: taskEntry(
          yield* applyTaskMove(collab, {
            taskId: input.taskId,
            action: input.verdict === "approve" ? "accept" : "reopen",
            ...(input.note !== undefined ? { note: input.note } : {}),
          }),
        ),
      }
    }),
  )
})

/** The turn-cost ledger, newest first, with the per-agent totals beside it. */
export const ledger = Effect.fn("ACPCollab.ledger")(function* (
  directory: string,
  input: { collabId: string; limit?: number },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      const store = yield* CollabStore.Service
      return {
        entries: (yield* store.listCosts(collab.id, input.limit)).map(ledgerEntry),
        // Totals cover the WHOLE ledger, never just the page above: a cost
        // shown against a page would understate what the room has spent.
        totals: yield* store.costTotals(collab.id),
      }
    }),
  )
})

/**
 * Stop a running collab NOW.
 *
 * The turn in flight is interrupted, everything queued behind it is dropped and
 * the rest of the hop budget is spent, which is what holds an agent that was
 * queued a moment before the button was pressed. Nothing is archived and
 * nothing is deleted: the next human post buys a new budget and the room picks
 * up from what is already in the log.
 */
export const stop = Effect.fn("ACPCollab.stop")(function* (directory: string, input: { collabId: string }) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      yield* (yield* CollabRunner.Service).stop(collab.id)
      return { ok: true as const }
    }),
  )
})

/**
 * Stop ONE agent and leave the room running.
 *
 * The whole-room `collab_stop` above is the sledgehammer: it interrupts the
 * drain, drops everyone still queued and spends the budget. This ends one
 * agent's turn and takes one slug out of the queue; every other member keeps
 * its place and the budget is untouched, because the human stopped an agent,
 * not the work.
 *
 * Answers what it actually did rather than a bare ok - "stopped" means
 * something different for a running agent than for one that was only waiting,
 * and a shell that cannot tell them apart cannot say so either.
 */
export const stopAgent = Effect.fn("ACPCollab.stopAgent")(function* (
  directory: string,
  input: { collabId: string; agentSlug: string },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      yield* requireMember(collab.id, input.agentSlug)
      return yield* (yield* CollabRunner.Service).stopAgent(collab.id, input.agentSlug)
    }),
  )
})

/**
 * Correct ONE agent: a human message addressed to it alone, whose turn is moved
 * to the front of the queue so the correction lands before the work it is
 * correcting carries on.
 *
 * A message, not a control, so it goes into the log as an ordinary addressed
 * post and buys a fresh hop budget exactly as `collab_post` does - which is
 * what lets a suspended room be steered rather than only released.
 */
export const redirect = Effect.fn("ACPCollab.redirect")(function* (
  directory: string,
  input: { collabId: string; agentSlug: string; text: string },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      if (collab.archivedAt !== undefined) return yield* failed(`collab is archived: ${input.collabId}`)
      yield* requireMember(collab.id, input.agentSlug)
      yield* bindContext(collab.id)
      const message = yield* (yield* CollabRunner.Service).redirect({
        collabId: collab.id,
        agentSlug: input.agentSlug,
        text: input.text,
      })
      return { seq: message.seq }
    }),
  )
})

/**
 * Archive a collab. The row stays and `collab_list` keeps returning it: an
 * archived stream is a READ-ONLY stream, not a deleted one, and its log is
 * usually the reason anyone archived it rather than throwing it away.
 */
export const archive = Effect.fn("ACPCollab.archive")(function* (directory: string, input: { collabId: string }) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      yield* (yield* CollabStore.Service).archive(collab.id)
      return { ok: true as const }
    }),
  )
})

/**
 * Reopen an archived collab: the room takes turns again from the next post.
 * Nothing is rewound - every member keeps its session and its last-seen marker,
 * so the first post after this gives each agent what it missed rather than the
 * whole log. `loadCollab` still refuses an id nobody has, and a room that was
 * never archived answers ok, because "make this room live" is the ask.
 */
export const unarchive = Effect.fn("ACPCollab.unarchive")(function* (directory: string, input: { collabId: string }) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      yield* (yield* CollabStore.Service).unarchive(collab.id)
      return { ok: true as const }
    }),
  )
})

export const rename = Effect.fn("ACPCollab.rename")(function* (
  directory: string,
  input: { collabId: string; title: string },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      const title = input.title.trim()
      // A blank title would leave the stream unnameable in every list it
      // appears in, so it is refused rather than stored.
      if (title.length === 0) return yield* failed(`collab title must not be empty: ${input.collabId}`)
      yield* (yield* CollabStore.Service).rename(collab.id, title)
      return { ok: true as const }
    }),
  )
})

export const addParticipant = Effect.fn("ACPCollab.addParticipant")(function* (
  directory: string,
  input: { collabId: string; agentSlug: string },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      const registry = yield* Agent.Service
      // Re-scan first and fail-closed after, exactly as `create` does: a roster
      // entry no definition backs can never take a turn, and reads as that
      // member ignoring everyone.
      yield* registry.rescan()
      const capable = (yield* registry.list()).filter(collabCapable).some((info) => info.name === input.agentSlug)
      if (!capable) return yield* failed(yield* rejection(input.agentSlug))
      yield* (yield* CollabStore.Service).addParticipant(collab.id, input.agentSlug)
      return { ok: true as const }
    }),
  )
})

/**
 * Take an agent off the roster. A SOFT delete: its session is left alone and
 * its messages stay in the log, because the log is the record of what was said
 * and removing a member cannot rewrite it.
 */
export const removeParticipant = Effect.fn("ACPCollab.removeParticipant")(function* (
  directory: string,
  input: { collabId: string; agentSlug: string },
) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const collab = yield* loadCollab(input.collabId)
      yield* (yield* CollabStore.Service).removeParticipant(collab.id, input.agentSlug)
      return { ok: true as const }
    }),
  )
})

export * as ACPCollab from "./acp"
