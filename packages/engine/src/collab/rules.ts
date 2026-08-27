import type { CollabStore } from "./store"

/**
 * Whether one roster agent replies to one Collab message.
 *
 * v2 is MECHANICAL: every decision reads the message's KIND and its structured
 * `mentions` list, never its prose. A model that writes "@crane" in a sentence
 * is referring to a colleague, not summoning one - under v1 that reference woke
 * crane, so two agents discussing a third could keep the room awake forever
 * without anyone asking for anything.
 *
 * The policy stays an ORDERED first-match rule list: a new behaviour is a new
 * rule at the right POSITION, and the position is the whole policy.
 *
 * Evaluation is FAIL-CLOSED. A rule that throws ends the whole evaluation at
 * "skip"; it never falls through to a later rule. A broken rule that let
 * messages fall through to a permissive one would make agents answer things the
 * policy meant to filter, and in a room that bills per turn that is the
 * expensive direction to be wrong in.
 */

export type Decision = "reply" | "skip"

export type Subject = {
  /** The agent being asked. Never the author of `message` in a scheduled fan-out. */
  readonly agentSlug: string
  /** The agent's `description`, which is the label a human sees. */
  readonly displayName: string
}

export type Message = {
  readonly authorId: string
  readonly authorKind: "human" | "agent"
  /** What the entry IS. Routing reads this, never the prose. */
  readonly kind: CollabStore.MessageKind
  /** The slugs this message addresses. Empty addresses nobody. */
  readonly mentions: readonly string[]
}

/** The board row a `task_*` message is about, when it has one. */
export type Task = {
  readonly createdBy: string
  readonly owner: string | null
}

export type Input = {
  readonly subject: Subject
  readonly message: Message
  /**
   * The ACTIVE roster at decision time, `subject` included. Absent means
   * "roster unknown", which the addressing rule treats as "take the list as
   * given" rather than guessing.
   */
  readonly roster?: readonly Subject[]
  /** The agent an unaddressed human message reaches. null = nobody. */
  readonly lead?: string | null
  /** The task `message.taskId` names, when the caller loaded one. */
  readonly task?: Task
  /**
   * What KIND of room this is. Absent = `discuss`, which is every room that
   * shipped before council mode and the reading of any stored value this build
   * does not recognise (`CollabCouncil.flavorOf`).
   *
   * It is a ROUTING fact, so it belongs here and not only in the runner: a
   * council sends an unaddressed question to the whole room instead of to the
   * lead, and the composer preview is this same stack. A preview that named the
   * lead where the room would wake five agents would teach a rule the room does
   * not have.
   */
  readonly flavor?: "discuss" | "council"
}

export type Rule = {
  readonly name: string
  /** `undefined` = this rule has no opinion; try the next one. */
  readonly evaluate: (input: Input) => Decision | undefined
}

/** The slugs a message addresses that are still in the room. */
const addressed = (input: Input) => {
  const roster = input.roster
  if (roster === undefined) return input.message.mentions
  return input.message.mentions.filter((slug) => roster.some((entry) => entry.agentSlug === slug))
}

export const SELF: Rule = {
  name: "self",
  evaluate: ({ subject, message }) => (message.authorId === subject.agentSlug ? "skip" : undefined),
}

/**
 * Whether this is something a participant SAID, as opposed to a row the board
 * left behind.
 *
 * The human rules below route conversation. A human moving a task writes a
 * `task_*` row with the human's name on it, and treating that as a question for
 * the lead would spend a turn on every checkbox - while ALSO shadowing the
 * board rule that knows who actually has to act on it.
 */
const isChat = (message: Message) => message.kind === "say"

/**
 * A human message that names agents is a question for exactly those agents.
 *
 * The names come from the structured `mentions` list `collab_post` validated
 * against the active roster, so an unknown slug was refused before anything was
 * written. A named agent that LEFT afterwards simply is not reached: v1 fanned
 * such a message out to the whole room "so it reaches someone", which turned a
 * question for one departed agent into a turn from every remaining one.
 */
export const HUMAN_MENTION: Rule = {
  name: "human-mention",
  evaluate: (input) => {
    if (input.message.authorKind !== "human" || !isChat(input.message)) return undefined
    if (input.message.mentions.length === 0) return undefined
    return addressed(input).includes(input.subject.agentSlug) ? "reply" : "skip"
  },
}

/**
 * IN A COUNCIL, an unaddressed question goes to EVERYONE - and so does the
 * synthesizer's follow-up.
 *
 * Positioned deliberately BETWEEN {@link HUMAN_MENTION} and {@link HUMAN_LEAD}:
 * the position is the policy.
 *
 *  - AFTER the mention rule, so `@crane what do you think` still asks crane
 *    alone. Naming members is how a human narrows a council for one question,
 *    and a mode that swallowed the address list would take that away.
 *  - BEFORE the lead rule, so an UNADDRESSED question reaches the whole room
 *    rather than one seat. That is the mode: a council's value is independent
 *    first opinions, and there is nothing independent about one answer.
 *
 * A `council_question` reaches everyone regardless of address, because it is
 * the synthesizer asking its own council. {@link SELF} has already taken the
 * asker out, so it is never woken by its own follow-up.
 */
export const COUNCIL: Rule = {
  name: "council",
  evaluate: ({ message, flavor }) => {
    if (flavor !== "council") return undefined
    if (message.kind === "council_question") return "reply"
    if (message.authorKind !== "human" || !isChat(message)) return undefined
    return message.mentions.length === 0 ? "reply" : undefined
  },
}

/**
 * An unaddressed human message goes to the LEAD alone.
 *
 * v1 woke the whole room, which spent a turn from every agent on one question
 * and made three-agent rooms answer in triplicate. With no lead nobody wakes -
 * `collab_post` answers `notice: 'no-lead'` so the human is told, rather than
 * left watching a room that will never reply.
 */
export const HUMAN_LEAD: Rule = {
  name: "human-lead",
  evaluate: ({ subject, message, lead }) => {
    if (message.authorKind !== "human" || !isChat(message)) return undefined
    return lead !== undefined && lead !== null && lead === subject.agentSlug ? "reply" : "skip"
  },
}

/**
 * An answer wakes NOBODY. The agent that asked already holds it as the result
 * of its own tool call, and everyone else was never part of the exchange.
 */
export const ANSWER: Rule = {
  name: "answer",
  evaluate: ({ message }) => (message.kind === "answer" ? "skip" : undefined),
}

/**
 * An ask or a hand-off reaches its target only, and the RUNNER routes it: an
 * ask runs nested inside the caller's own turn, a hand-off passes the baton by
 * queueing the target directly. Either way the rule stack must not schedule a
 * second turn for the same message.
 */
export const DIRECTED: Rule = {
  name: "directed",
  evaluate: ({ message }) => (message.kind === "ask" || message.kind === "handoff" ? "skip" : undefined),
}

/**
 * Board moves that need someone to act: finished work goes back to whoever
 * asked for it, and reopened work goes back to whoever owns it. Every other
 * board move is bookkeeping and wakes no one.
 */
export const TASK: Rule = {
  name: "task",
  evaluate: ({ subject, message, task }) => {
    if (message.kind === "task_done") {
      if (!task) return "skip"
      // A task the human opened has no agent to accept it, and an agent that
      // completed its own task would be waking itself to accept it.
      if (task.createdBy === "user" || task.createdBy === message.authorId) return "skip"
      return task.createdBy === subject.agentSlug ? "reply" : "skip"
    }
    if (message.kind === "task_reopen") {
      if (!task || task.owner === null || task.owner === message.authorId) return "skip"
      return task.owner === subject.agentSlug ? "reply" : "skip"
    }
    return undefined
  },
}

/** Anything an earlier rule did not claim is silence. Keeps `decide` total. */
export const SILENT: Rule = {
  name: "silent",
  evaluate: () => "skip",
}

/**
 * The fixed stack, in contract order: never self, route a human's addressed
 * message to exactly those agents, put an unaddressed one to the whole COUNCIL
 * where the room is one, send it to the lead where it is not, keep answers and
 * directed messages out of the scheduler, hand finished and reopened work back
 * to the agent that owns it, and stay silent otherwise.
 *
 * An agent's ordinary `say` therefore wakes nobody at all. Talking is not
 * addressing, and a room where it was could never come to rest. An `opinion`
 * and a `synthesis` fall through to {@link SILENT} for exactly that reason and
 * need no rule of their own: a council that answered its own answers would
 * never stop.
 */
export const DEFAULT_RULES: readonly Rule[] = [
  SELF,
  HUMAN_MENTION,
  COUNCIL,
  HUMAN_LEAD,
  ANSWER,
  DIRECTED,
  TASK,
  SILENT,
]

export function decide(input: Input, rules: readonly Rule[] = DEFAULT_RULES): Decision {
  for (const rule of rules) {
    let decision: Decision | undefined
    try {
      decision = rule.evaluate(input)
    } catch {
      return "skip"
    }
    if (decision !== undefined) return decision
  }
  return "skip"
}

/**
 * Who a HUMAN message addressing `mentions` would wake, in roster order.
 *
 * This is the C14 composer preview, and it is here rather than in the ACP layer
 * for one reason: it must not become a second policy. It runs {@link decide}
 * over the same stack the runner fans out on, so a rule that changes moves the
 * preview with it - a preview that is right where the room is wrong would teach
 * the user a routing rule the room does not have.
 *
 * Token-free by construction: the rules read the message's kind and its address
 * list, never its prose, so there is nothing here to send to a model. The
 * draft's TEXT is deliberately not a parameter for the same reason.
 *
 * The hop budget is not consulted either, and must not be: the post this
 * previews is a human one, and a human post buys a fresh budget before it fans
 * out, so a spent budget never narrows the answer.
 */
export function wakeSet(
  input: {
    /** The ACTIVE roster. An address outside it reaches nobody. */
    readonly roster: readonly Subject[]
    readonly lead: string | null
    readonly mentions: readonly string[]
    /** Absent = `discuss`. A council previews as the whole room, because it is. */
    readonly flavor?: "discuss" | "council"
  },
  rules: readonly Rule[] = DEFAULT_RULES,
): string[] {
  const message: Message = { authorId: "user", authorKind: "human", kind: "say", mentions: input.mentions }
  return input.roster
    .filter(
      (subject) =>
        decide(
          {
            subject,
            message,
            roster: input.roster,
            lead: input.lead,
            ...(input.flavor !== undefined ? { flavor: input.flavor } : {}),
          },
          rules,
        ) === "reply",
    )
    .map((subject) => subject.agentSlug)
}

export * as CollabRules from "./rules"
