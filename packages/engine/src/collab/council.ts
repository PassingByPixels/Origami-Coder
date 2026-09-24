import type { CollabStore } from "./store"
import { CollabParallel } from "./parallel"

/**
 * Council mode: several models deliberating as equals, as a room flavor.
 *
 * An ordinary collab is a CHAIN - speaker two reads speaker one's fresh reply -
 * which would anchor answers 2..N on answer 1. A council is instead a runner
 * mode: one human question dispatches to every active participant at once,
 * each reading the room cut at the question.
 *
 * Invariants a future edit could break: the blind cut is the ROUND's, not the
 * dispatch's - one ceiling (the opening question's seq) applies to every
 * opinion however late it is claimed; the hop budget counts ROUNDS, not turns,
 * so it cannot expire mid-round over a truncated council; every member settles
 * exactly once, and the round closes on the last settle so a dead member
 * cannot hang it.
 *
 * Pure - no Effect, no store, no fibers; the runner wires this policy up.
 */

/** What a room IS. Absent = discuss. */
export type Flavor = "discuss" | "council"

/** Which half of a round one turn is. */
export type Phase = "opinion" | "synthesis"

/** How one member's opinion turn ended. Four outcomes, never folded to two. */
export type Outcome = "answered" | "silent" | "failed" | "stopped"

/**
 * The stored flavor, resolved ONCE. An unrecognised value reads as `discuss`:
 * a council's parallel dispatch is only safe because every round turn is
 * sealed read-only, and an engine that does not know a flavor cannot seal it.
 */
export function flavorOf(value: string | null | undefined): Flavor {
  return value === "council" ? "council" : "discuss"
}

/**
 * How many opinion turns a room of this flavor dispatches at once.
 *
 * A council's width comes with the flavor, clamped at
 * {@link CollabParallel.CONCURRENCY_MAX}. The width's write hazard is answered
 * without a setting: every round turn runs read-only (`CollabSeal.COUNCIL_SEAL`).
 */
export function dispatchWidth(flavor: string | null | undefined): number {
  return flavorOf(flavor) === "council" ? CollabParallel.CONCURRENCY_MAX : 1
}

/**
 * Who reconciles the round: the LEAD when it is still in the room, else the
 * FIRST member in roster order. Arbitrary but DETERMINISTIC - two readings of
 * one room must name the same synthesizer. The synthesizer is a full member:
 * it gives an opinion in the round like everyone else, then reconciles.
 */
export function pickSynthesizer(members: readonly string[], lead: string | null | undefined): string | undefined {
  if (lead && members.includes(lead)) return lead
  return members[0]
}

/**
 * Whether this message OPENS a round.
 *
 * Read off the message's KIND and its author, never its prose. Only a human
 * message and a `council_question` open one; an OPINION deliberately does not,
 * or a council would never come to rest.
 */
export function opensRound(
  flavor: string | null | undefined,
  message: { readonly authorKind: "human" | "agent"; readonly kind: CollabStore.MessageKind },
): boolean {
  if (flavorOf(flavor) !== "council") return false
  if (message.kind === "council_question") return true
  return message.authorKind === "human" && message.kind === "say"
}

/** One live round. Mutable by the {@link Registry} alone. */
export type Round = {
  /** Distinguishes this round from one that replaced it. See `settle`. */
  readonly id: number
  /** The opening message's seq: the BLIND CUT every opinion is read at. */
  readonly ceiling: number
  readonly synthesizer: string
  /** Every member this round is waiting on, in roster order. The `m` of n-of-m. */
  readonly members: readonly string[]
  readonly settled: Map<string, Outcome>
  /** Set by `takeClosed`, so the close happens exactly once. */
  closed: boolean
}

/** What one claimed turn is, as far as the round is concerned. */
export type Dispatch = {
  readonly roundId: number
  readonly phase: Phase
  /** Present on an OPINION only. The synthesis is meant to read everything. */
  readonly ceiling?: number
}

export interface Registry {
  /**
   * Start a round, replacing whatever was open. Answers the new round, or
   * undefined when there is nobody to ask. The abandoned round's turns are
   * still in flight; the round `id` keeps their late settles off the new round.
   */
  readonly open: (input: {
    collabId: string
    ceiling: number
    members: readonly string[]
    synthesizer: string
  }) => Round | undefined
  readonly get: (collabId: string) => Round | undefined
  /** The round turn this agent is owed, or undefined when it is not in a round.
   *  An opinion carries the round's blind cut; the synthesis carries none. */
  readonly dispatchFor: (collabId: string, agentSlug: string) => Dispatch | undefined
  /**
   * Record how one turn ended. The FIRST outcome for a member wins: the runner
   * settles a turn both where its reply lands and where its fiber is joined,
   * and those are one turn. A dispatch from a superseded round is ignored.
   */
  readonly settle: (collabId: string, dispatch: Dispatch, agentSlug: string, outcome: Outcome) => void
  /** The round that has just become complete, ONCE. Two workers can settle the
   *  last two members in the same instant; exactly one gets the round back. */
  readonly takeClosed: (collabId: string) => Round | undefined
  /** Drop the round and answer it, for a caller that has to record how far it got. */
  readonly abandon: (collabId: string) => Round | undefined
}

export function makeRegistry(): Registry {
  const rounds = new Map<string, Round>()
  let nextId = 1

  const live = (collabId: string, dispatch: Dispatch): Round | undefined => {
    const round = rounds.get(collabId)
    return round && round.id === dispatch.roundId ? round : undefined
  }

  return {
    open: ({ collabId, ceiling, members, synthesizer }) => {
      if (members.length === 0) return undefined
      const round: Round = {
        id: nextId++,
        ceiling,
        synthesizer,
        members: [...members],
        settled: new Map(),
        closed: false,
      }
      rounds.set(collabId, round)
      return round
    },
    get: (collabId) => rounds.get(collabId),
    dispatchFor: (collabId, agentSlug) => {
      const round = rounds.get(collabId)
      if (!round) return undefined
      if (round.closed) {
        return agentSlug === round.synthesizer ? { roundId: round.id, phase: "synthesis" } : undefined
      }
      if (!round.members.includes(agentSlug)) return undefined
      return { roundId: round.id, phase: "opinion", ceiling: round.ceiling }
    },
    settle: (collabId, dispatch, agentSlug, outcome) => {
      const round = live(collabId, dispatch)
      if (!round) return
      if (dispatch.phase === "synthesis") {
        // The synthesis is the last thing a round does; leaving the round
        // behind would give the next question a stale ceiling to read at.
        rounds.delete(collabId)
        return
      }
      if (!round.members.includes(agentSlug)) return
      if (round.settled.has(agentSlug)) return
      round.settled.set(agentSlug, outcome)
    },
    takeClosed: (collabId) => {
      const round = rounds.get(collabId)
      if (!round || round.closed) return undefined
      if (round.settled.size < round.members.length) return undefined
      round.closed = true
      return round
    },
    abandon: (collabId) => {
      const round = rounds.get(collabId)
      if (!round) return undefined
      rounds.delete(collabId)
      // A round whose summary has ALREADY been taken is not abandoned - it
      // finished, and is only still here because its synthesis is running.
      return round.closed ? undefined : round
    },
  }
}

/** How one unanswered member reads in the record. */
const ABSENCE: Record<Exclude<Outcome, "answered">, string> = {
  silent: "had nothing to add",
  stopped: "was stopped",
  failed: "failed",
}

/** A member the round never got an answer out of at all - the room was stopped
 *  under it, or a second question replaced its round. Not folded into
 *  "stopped": nobody stopped this agent. */
const UNSETTLED = "did not answer"

/**
 * The round's own line in the room: n of m, and WHO is missing from the n.
 *
 * The count alone is not honesty - silence, a stop and a failure are not
 * interchangeable. Written for the room, so it is also what the synthesizer
 * reads: a synthesis over two opinions believing it had three would state a
 * consensus that was never taken.
 */
export function roundSummary(round: Round, nameOf: (agentSlug: string) => string): string {
  const answered = round.members.filter((slug) => round.settled.get(slug) === "answered")
  const head = `Council round: ${answered.length} of ${round.members.length} answered.`
  const missing = round.members
    .map((slug) => ({ slug, outcome: round.settled.get(slug) }))
    .filter((entry) => entry.outcome !== "answered")
    .map(
      (entry) =>
        `${nameOf(entry.slug)} ${entry.outcome && entry.outcome !== "answered" ? ABSENCE[entry.outcome] : UNSETTLED}`,
    )
  if (missing.length === 0) return head
  return `${head} ${missing.join("; ")}.`
}

/**
 * The instruction a SYNTHESIS turn opens with.
 *
 * The opinions ride under it as an ordinary envelope with the round's summary
 * line, so the count is stated once. The question is not repeated: the
 * synthesizer just gave its own opinion on it, so it is already in its session.
 */
export const SYNTHESIS_BRIEF: string = [
  "[Council] The round has closed and every opinion below is now visible to the whole room.",
  "You are reconciling it. Read them all, including your own, and answer the question this round was opened on:",
  "say where the council agrees, where it does not, and what you conclude - naming who held which position.",
  "Do not repeat the opinions back. If the council cannot answer without more from it, use `council_ask` to put ONE follow-up question to the room; otherwise state the decision and stop.",
].join("\n")

/**
 * A synthesis turn's whole synthetic user message.
 *
 * Unlike an ordinary envelope this does NOT drop the reader's own messages: a
 * reconciliation that omitted one of the positions it claims to reconcile
 * would be a count that does not match its own list.
 */
export function synthesisEnvelope(input: {
  readonly title: string
  readonly messages: readonly { readonly authorId: string; readonly text: string }[]
}): string {
  return [
    `[Collab: ${input.title}] ${SYNTHESIS_BRIEF}`,
    ...input.messages.map((message) => `${message.authorId}: ${message.text}`),
  ].join("\n")
}

/**
 * The author of the round's own record row: the ROOM talking about itself, not
 * a participant. `authorKind` stays `agent` for a mechanical reason - a `human`
 * author buys a fresh hop budget (`append`), so a bookkeeping row written as a
 * human would silently refill the budget the round just spent.
 */
export const RECORD_AUTHOR = "collab"

export * as CollabCouncil from "./council"
