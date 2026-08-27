import type { CollabStore } from "./store"
import { CollabParallel } from "./parallel"

/**
 * COUNCIL MODE — several models deliberating as EQUALS, as a room FLAVOR.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A FLAVOR AND NOT A ROSTER TEMPLATE.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A collab has always been a CHAIN: every speaker's envelope is built at drain
 * time, so speaker two reads speaker one's fresh reply (runner.ts's header).
 * That is what makes an ordinary room converge - and it is exactly what ruins a
 * council, because answers 2..N are then anchored on answer 1. A "council" that
 * was only a saved roster would produce ordered agreement and look like the
 * feature working, which is the failure the design report named.
 *
 * So a council is a RUNNER MODE. One human question dispatches to every active
 * participant at once, each reading the room CUT AT THE QUESTION, and no member
 * can see a sibling's opinion until the round is over.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ROUND IS THE UNIT. THREE CONSEQUENCES.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 1. THE BLIND CUT IS THE ROUND'S, NOT THE DISPATCH'S. The parallel wave gave
 *    every concurrent turn a mark taken when it was CLAIMED
 *    (`CollabParallel.visibleAtDispatch`). That is right for an ordinary wide
 *    room and WRONG for a council: a five-member council on a four-wide
 *    scheduler claims its fifth member after somebody has already answered, so
 *    a per-claim mark would let the fifth read the first. A round therefore
 *    fixes ONE ceiling - the opening question's seq - and every opinion in it
 *    is cut there however late it is claimed. This is the whole point of the
 *    mode, and it is the one line that enforces it.
 *
 * 2. THE HOP BUDGET COUNTS ROUNDS, NOT TURNS. A round is charged ONE hop when
 *    it opens, and the opinions and the synthesis inside it are free. Charging
 *    per turn would let a budget expire MID-ROUND, and a half-funded round is
 *    not a cheaper round - it is a synthesis over a truncated council, reported
 *    as "2 of 4 answered" for a reason that is not a failure of anybody's. The
 *    budget's real question is "how many times may this room act before it
 *    comes back to me", and in a council the unit of acting is the round.
 *
 * 3. A DEAD MEMBER CANNOT HANG THE ROUND. Every member settles exactly once,
 *    with the truth: it answered, it had nothing to add, its turn failed, or a
 *    human stopped it. The round closes on the LAST settle whatever those
 *    outcomes were, and {@link roundSummary} writes them into the room. A
 *    council that silently waited on a broken provider would look identical to
 *    one that is still thinking.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Everything here is PURE - no Effect, no store, no fibers. The runner owns one
 * {@link Registry} and calls into it; what that file adds is wiring, and what
 * this file adds is the policy, testable with neither.
 */

/** What a room IS. Absent (every room that shipped before this) = discuss. */
export type Flavor = "discuss" | "council"

/** Which half of a round one turn is. */
export type Phase = "opinion" | "synthesis"

/** How one member's opinion turn ended. Four outcomes, never folded to two. */
export type Outcome = "answered" | "silent" | "failed" | "stopped"

/**
 * The stored flavor, resolved ONCE.
 *
 * Anything this build does not recognise reads as `discuss`, which is the
 * SAFEST reading rather than the most recent: a council dispatches in parallel,
 * and parallel dispatch is only safe here because every round turn is sealed
 * read-only. An engine that does not know a flavor cannot seal the turns that
 * flavor would dispatch, so it must not honour one written by a newer shell.
 */
export function flavorOf(value: string | null | undefined): Flavor {
  return value === "council" ? "council" : "discuss"
}

/**
 * How many opinion turns a room of this flavor dispatches at once.
 *
 * A council does NOT ask the human to also find the concurrency control. Its
 * members answering one at a time would be the anchored room this mode exists
 * to replace, so the width comes with the flavor - clamped at
 * {@link CollabParallel.CONCURRENCY_MAX}, which is the same watchability
 * ceiling every wide room obeys, and the same reason: a stream that interleaves
 * faster than a human reads is not a room anybody is supervising.
 *
 * The width brings the write hazard a raised `concurrency` brings, and a council
 * answers it WITHOUT a gate on the setting. Every round turn - each opinion and
 * the synthesis - runs read-only (`CollabSeal.COUNCIL_SEAL`), so a room of
 * ordinary working bots becomes a council with nothing to configure, and each of
 * those bots keeps every door it owns in the DISCUSS turns of the same room. It
 * costs a council nothing either way: the design report's own verdict is that a
 * council deliberates and does not build.
 */
export function dispatchWidth(flavor: string | null | undefined): number {
  return flavorOf(flavor) === "council" ? CollabParallel.CONCURRENCY_MAX : 1
}

/**
 * Who reconciles the round.
 *
 * The LEAD, when it is still in the room - it is already the seat an
 * unaddressed message goes to, and a council that synthesised somewhere else
 * would have two answers to "who speaks for this room". Leadless, the FIRST
 * member in roster order: arbitrary, but DETERMINISTIC and visible, which is
 * what matters. Two readings of one room must name the same synthesizer or the
 * record disagrees with itself.
 *
 * The synthesizer is a full member of its own council: it gives an opinion in
 * the round like everyone else, and then reconciles. It is not a chair sitting
 * above the room.
 */
export function pickSynthesizer(members: readonly string[], lead: string | null | undefined): string | undefined {
  if (lead && members.includes(lead)) return lead
  return members[0]
}

/**
 * Whether this message OPENS a round.
 *
 * Read off the message's KIND and its author, never its prose - the same
 * mechanical rule the wake stack obeys. Two things open a round and nothing
 * else does:
 *
 *  - a human saying something, which is the question the council is for;
 *  - a `council_question`, which is the synthesizer putting a follow-up back to
 *    the council after reading its answers.
 *
 * An OPINION deliberately does not. A council whose answers re-asked the
 * question would never come to rest, and the budget that bounds it counts
 * rounds.
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
   * undefined when there is nobody to ask.
   *
   * Replacing rather than refusing is the honest reading of a human who asks a
   * second question mid-round: the new question is the one they want answered.
   * The abandoned round's turns are still in flight, and the round `id` is what
   * keeps their late settles off the round that replaced it.
   */
  readonly open: (input: {
    collabId: string
    ceiling: number
    members: readonly string[]
    synthesizer: string
  }) => Round | undefined
  readonly get: (collabId: string) => Round | undefined
  /**
   * The round turn this agent is owed, or undefined when it is not in a round.
   * An opinion carries the round's blind cut; the synthesis carries none.
   */
  readonly dispatchFor: (collabId: string, agentSlug: string) => Dispatch | undefined
  /**
   * Record how one turn ended. The FIRST outcome for a member wins: the runner
   * settles a turn both where its reply lands and again where its fiber is
   * joined, and those are one turn, not two.
   *
   * A dispatch from a superseded round is ignored outright.
   */
  readonly settle: (collabId: string, dispatch: Dispatch, agentSlug: string, outcome: Outcome) => void
  /**
   * The round that has just become complete, ONCE. Two workers can settle the
   * last two members in the same instant; exactly one of them gets the round
   * back and does the closing.
   */
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
        // The synthesis is the last thing a round does. However it ended -
        // spoken, silent or broken - the round is over, and leaving it behind
        // would give the next question a stale ceiling to read at.
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
      // That is the ordinary way a follow-up round begins, and answering it
      // here would put a second n-of-m line in the room for one council.
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

/**
 * A member the round never got an answer OUT of at all - because the room was
 * stopped under it, or because a second question replaced the round it was
 * still working on. Not folded into "stopped": nobody stopped this agent, and
 * saying so would send a human looking for a control they never touched.
 */
const UNSETTLED = "did not answer"

/**
 * The round's own line in the room: n of m, and WHO is missing from the n.
 *
 * The count alone is not honesty. "2 of 3 answered" tells a reader that
 * somebody is absent and nothing about which member or why, and the three
 * reasons are not interchangeable - a member that chose silence agreed to be
 * counted, one that was stopped was overruled by the human, and one that failed
 * is a broken provider the human has to go and fix.
 *
 * Written for the room, so it is also what the synthesizer reads: a synthesis
 * that reconciled two opinions believing it had three would state a consensus
 * that was never taken.
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
 * The opinions ride UNDER it as an ordinary envelope, and the round's own
 * summary line rides with them - so the count is stated once, in the room,
 * rather than twice in one prompt.
 *
 * The QUESTION is deliberately not repeated either. The synthesizer is a full
 * member that has just given its own opinion on it, so the question is already
 * in its child session as the turn before this one; restating it would read as
 * the human asking twice.
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
 * Unlike an ordinary envelope this does NOT drop the reader's own messages. An
 * envelope leaves them out because they are already in the reader's session as
 * its own assistant turns and reading them back sounds like somebody else said
 * them. A synthesis is not a conversation turn - it is a reconciliation over a
 * record, and a record that silently omitted one of the positions it claims to
 * be reconciling would be a count that does not match its own list.
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
 * The author of the round's own record row.
 *
 * Not a participant, and deliberately not a slug any definition can hold: the
 * summary is the ROOM talking about itself. `authorKind` stays `agent` for a
 * mechanical reason worth stating - a `human` author buys a fresh hop budget
 * (`append`), so a bookkeeping row written as a human would silently refill the
 * budget the round just spent.
 */
export const RECORD_AUTHOR = "collab"

export * as CollabCouncil from "./council"
