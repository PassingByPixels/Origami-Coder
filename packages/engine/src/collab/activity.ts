import type { SessionV1 } from "@origami/core/v1/session"

/**
 * What a running collab turn shows the room, and what is KEPT of it.
 *
 * Split out of the runner because it is a subject of its own - a pure reading
 * of one session message - and because the retention below has to be provable
 * without standing a runner, a store and a coordinator up first.
 *
 * Two different questions are answered here. `turnActivity` says what a turn
 * has done SO FAR, read off the message it is still writing. `mergeActivity`
 * says what an agent has done LATELY, which outlives the turn: a chip that only
 * ever shows the newest line makes a room look like it is thinking rather than
 * working (report F3).
 */

/** One thing an agent did or thought, as a roster chip renders it. */
export type ActivitySignal = {
  readonly kind: "tool" | "thought"
  readonly text: string
}

/** The wire's own bound on one signal's `text` - see the collab_state contract. */
export const LIVE_ACTIVITY_MAX_CHARS = 200

/**
 * How many signals one agent keeps.
 *
 * Deliberately small. The retained log rides EVERY `collab_state` poll, so its
 * size is paid on a 1200 ms cadence per open room; twenty entries at the
 * signal bound above is the most that stays free at that rate.
 */
export const ACTIVITY_LOG_MAX = 20

/**
 * One retained signal. The message id is carried because it is the TURN's
 * identity: it is what lets a re-read of the same in-progress message replace
 * what that message contributed rather than pile a second copy on top of it,
 * and it is what lets a shell group the log into turns.
 */
export type ActivityEntry = ActivitySignal & {
  readonly messageId: string
}

export function toolActivity(part: SessionV1.ToolPart): ActivitySignal {
  const state = part.state
  const input = "input" in state && state.input && typeof state.input === "object" ? state.input : undefined
  // The ARGUMENT first, exactly as `traceOf` picks it: the tool name alone
  // says "a read ran", not what it read.
  const arg = input
    ? Object.values(input).find((value): value is string => typeof value === "string" && value.length > 0)
    : undefined
  const text = arg ? `${part.tool}: ${arg}` : part.tool
  return { kind: "tool", text: text.length > LIVE_ACTIVITY_MAX_CHARS ? text.slice(0, LIVE_ACTIVITY_MAX_CHARS) : text }
}

/** `undefined` on blank text: a reasoning part with nothing streamed into it yet is not a signal. */
export function thoughtActivity(part: SessionV1.ReasoningPart): ActivitySignal | undefined {
  const text = part.text.trim()
  if (text.length === 0) return undefined
  // The TAIL, not the head: a reasoning part grows as it streams, so the
  // freshest words are the end of it, not the opening line.
  return { kind: "thought", text: text.length > LIVE_ACTIVITY_MAX_CHARS ? text.slice(-LIVE_ACTIVITY_MAX_CHARS) : text }
}

/**
 * EVERY signal one turn has produced so far, in the order it produced them.
 *
 * The whole message, not its newest part: a poll that only read the newest one
 * would keep whatever happened to be in flight at each tick and lose everything
 * between two ticks, so the log's contents would depend on the shell's poll
 * cadence rather than on what the agent did.
 */
export function turnActivity(message: SessionV1.WithParts | undefined): readonly ActivitySignal[] {
  if (!message) return []
  return message.parts.flatMap((part) => {
    if (part.type === "tool") return [toolActivity(part)]
    if (part.type !== "reasoning") return []
    const thought = thoughtActivity(part)
    return thought ? [thought] : []
  })
}

/**
 * Fold one fresh read of a turn into an agent's retained log.
 *
 * IDEMPOTENT per message: everything the named message contributed before is
 * dropped and replaced by what it says now, so re-reading a turn that has
 * grown by one tool call adds one entry rather than a second copy of the turn.
 *
 * The log is NOT cleared when a turn ends. "What has this agent been doing"
 * spans hops - that is the whole point of keeping it - so the cap, and only
 * the cap, is what ever removes an entry.
 */
export function mergeActivity(
  log: readonly ActivityEntry[],
  messageId: string,
  current: readonly ActivitySignal[],
  max: number = ACTIVITY_LOG_MAX,
): readonly ActivityEntry[] {
  const kept = log.filter((entry) => entry.messageId !== messageId)
  return [...kept, ...current.map((signal) => ({ ...signal, messageId }))].slice(-max)
}

export * as CollabActivity from "./activity"
