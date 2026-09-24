/**
 * The bounded continuation nudge: what the engine does when an OpenAI reply
 * says it is going to carry on, and then ends the turn instead. The step is
 * ordinary - `finish: "stop"`, real text, no tool call - so the exit gate ends
 * the turn; the model announced work instead of doing it. Provider-scoped on
 * purpose: a cross-provider nudge would change behaviour for every model on
 * the strength of one provider's habit.
 *
 * Five conditions must all hold, with a hard bound of two nudges:
 *   - the provider is OpenAI (API-key and ChatGPT-OAuth both carry `openai`);
 *   - a tool has already run in this turn, so the model is demonstrably
 *     mid-task - this is what keeps the nudge away from a one-shot reply;
 *   - the step finished `"stop"` with no tool call;
 *   - the last `TAIL_WINDOW` characters match an intent pattern;
 *   - fewer than `LIMIT` nudges have been spent on this turn.
 * Worst case is two extra steps, not a loop. It never rewrites, deletes or
 * re-sends what the model produced; repairing a dead or empty step is
 * `session/stream-drop.ts`, a different fact.
 */

/** The one provider this guard is allowed to fire for. */
export const PROVIDER = "openai"

/**
 * Nudges one turn may spend. One distinguishes a stall from a habit; a third
 * has never bought anything the second did not. A todo-list signal was weighed
 * and dropped: holding the turn open until a checklist is clean turns the
 * model's own planning note into a contract.
 */
export const LIMIT = 2

/**
 * How far back from the end of the prose the sign-off is looked for. A
 * continuation promise is the last thing a reply says; matching anywhere in a
 * long answer would fire on a model merely describing what it did earlier.
 */
export const TAIL_WINDOW = 300

/**
 * Marks the injected part as the engine's in the stored transcript, so a client
 * renders it as a system line and no reader mistakes it for something the user
 * typed. Sits beside `origami_truncated` and `origami_retry`.
 */
export const METADATA_KEY = "origami_continue_nudge"

/**
 * Marks the engine line that says the nudges are spent. Deliberately a separate
 * key: one is an injected user turn the model answers, the other a line only
 * the user reads, so a client filtering on one must not catch the other and a
 * test counting nudges must not count this.
 */
export const EXHAUSTED_METADATA_KEY = "origami_continue_nudge_exhausted"

/**
 * What the model is asked to do after a promise. Positively framed: a line
 * whose salient verb is "do not" spends its weight on what it would prevent.
 */
export const INSTRUCTION = "Continue; carry out the step you named."

/**
 * What the model is asked to do when the tail states what is left rather than
 * promising. "one tool call at a time" names the smallest possible unit of
 * action, leaving no room to answer with another inventory of what remains.
 */
export const REMAINING_INSTRUCTION = "Continue with the remaining work now, one tool call at a time."

/**
 * The byline, carried in the text so it reaches the model and the reader by the
 * same route. `<engine-note>` is the tag `session/prompt.ts` already uses.
 */
const AUTHOR = "<engine-note>The Origami engine wrote this line, not the user."

/** Why the engine spoke, so the transcript records the evidence. */
const BECAUSE: Record<Kind, string> = {
  promise: "The previous reply said it would carry on, then ended the turn.",
  remaining: "The previous reply stated that work remains, then ended the turn.",
}

/** The full body of the injected turn. */
export function text(kind: Kind): string {
  const instruction = kind === "promise" ? INSTRUCTION : REMAINING_INSTRUCTION
  return `${AUTHOR} ${BECAUSE[kind]}</engine-note>\n${instruction}`
}

/**
 * The line the user reads when the engine has asked twice and the reply still
 * says the same thing. A fact, not a verdict: it does not rule on whether the
 * model was right to stop. "Two" tracks `LIMIT` and moves with it.
 */
export function exhaustedNote(kind: Kind): string {
  const observed = kind === "promise" ? "still promises to continue" : "still describes remaining work"
  return `<engine-note>Two continuation nudges were sent this turn; the reply ${observed}.</engine-note>`
}

/**
 * The intent family: a promise of future work, or of a future report. What is
 * matched is the shape of the promise, not its wording - a set copied from one
 * transcript's exact sign-offs fails on the first synonym. The patterns are not
 * precise and never will be; what bounds the cost is the other four gates, so a
 * false positive costs at most two extra steps inside a turn that was ending
 * anyway. Known false positives: `ONCE_CONDITION` reads a past-tense report as
 * a promise, `WHEN_CONDITION` reads a reply parked on the user as one.
 *
 * Matched against normalised text (see `normalise`) - already lower-cased and
 * single-spaced, so no pattern spells case, apostrophes or line breaks twice,
 * and `.` cannot cross a newline because none survive.
 */

/** "I'll <do something>" / "I will <do something>". */
const FIRST_PERSON_PROMISE =
  /\bi(?:'ll| will) (?:continue|proceed|resume|carry on|notify|inform|report|confirm|return|let you know|tell you|update you|get back|come back|follow up|now)\b/

/**
 * A promise to report with no subject: "Will report when it completes." The
 * verb list stays narrow because the subject is unknown - a bare "will
 * continue" can be the build talking, "will report" cannot.
 */
const WILL_TELL = /\bwill (?:report|confirm|notify|inform|update|follow up)\b|\bwill let you know\b/

/** Bare progress words. "Underway." on its own is the whole promise. */
const IN_PROGRESS = /\b(?:continuing|proceeding|underway)\b/

/** "Next, I'll ..." - the plan-instead-of-action shape. */
const NEXT_I = /\bnext,? i(?:'ll| will)\b/

/** "once the pack is rebuilt", "once verified" - a condition on future work. */
const ONCE_CONDITION = /\bonce .{0,60}?\b(?:ready|complete[sd]?|done|finish(?:es|ed)?|rebuilt|verified)\b/

/** "when it is ready", "when complete" - the same, spelled the other way. */
const WHEN_CONDITION = /\bwhen .{0,40}?\b(?:ready|complete[sd]?|done|finish(?:es|ed)?|rebuilt|verified)\b/

export const PATTERNS: readonly RegExp[] = [
  FIRST_PERSON_PROMISE,
  WILL_TELL,
  IN_PROGRESS,
  NEXT_I,
  ONCE_CONDITION,
  WHEN_CONDITION,
]

/**
 * Lower-case, ASCII apostrophes, single-spaced. The apostrophe step is not
 * cosmetic: models emit U+2019, so ASCII-only patterns would match no real stop.
 */
export function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ")
}

/** True when the END of this prose promises more work. */
export function isContinueIntent(prose: string): boolean {
  const tail = normalise(prose.slice(-TAIL_WINDOW))
  return PATTERNS.some((pattern) => pattern.test(tail))
}

/**
 * The remaining-work family: prose that states what is not done and promises
 * nothing, so there is no intent for `PATTERNS` to match and this family reads
 * the fact instead. It shares `LIMIT` with the promise family and is checked
 * after it: "not yet complete" is also what an honest hand-back says when the
 * model is blocked and wants the user.
 */
const REMAINS_UNDONE = /\bremains? (?:undone|incomplete|open|outstanding)\b/
const STILL_OUTSTANDING = /\bstill (?:incomplete|undone|remaining|pending|to do|outstanding)\b/
const NOT_DONE = /\bnot (?:yet )?(?:done|complete|finished|applied)\b/
const ARE_INCOMPLETE = /\b(?:is|are) (?:still )?(?:incomplete|outstanding|pending)\b/
const LEFT_TO_DO = /\bleft to do\b/
const HAVE_NOT_BEEN = /\bhave not (?:yet )?been (?:done|applied|run|deployed)\b/

export const REMAINING_PATTERNS: readonly RegExp[] = [
  REMAINS_UNDONE,
  STILL_OUTSTANDING,
  NOT_DONE,
  ARE_INCOMPLETE,
  LEFT_TO_DO,
  HAVE_NOT_BEEN,
]

/** True when the END of this prose says work is outstanding. */
export function statesRemainingWork(prose: string): boolean {
  const tail = normalise(prose.slice(-TAIL_WINDOW))
  return REMAINING_PATTERNS.some((pattern) => pattern.test(tail))
}

/** Which family fired. Both are TAIL families and both share `LIMIT`. */
export type Kind = "promise" | "remaining"

export type Decision = {
  /** The provider id on the message that opened this turn. */
  readonly providerID: string
  readonly finish: string | undefined
  /** Whether THIS step committed a tool call - the exit gate's own test. */
  readonly hasToolCallThisStep: boolean
  /** Whether ANY earlier step of this turn ran a tool. */
  readonly sawToolCallThisTurn: boolean
  readonly prose: string
  /** Nudges already spent on this turn. */
  readonly nudges: number
  /**
   * origami_change (t-53vyxf): whether the guard may fire at all
   * (`ORIGAMI_CONTINUE_NUDGE`, "off" to silence it). Absent means on; the
   * switch exists for experiments, not to change the default.
   */
  readonly enabled?: boolean
}

/**
 * Why the engine did or did not speak. Always produced, never only on the yes,
 * so "why was this stop not nudged?" is answerable from the log alone.
 * `considered` separates "this was a candidate and the answer was no" from
 * "this was never a candidate"; only the first is worth a log line, because the
 * second fires on every turn end of every provider.
 */
export type Verdict =
  | { readonly nudge: true; readonly kind: Kind; readonly instruction: string; readonly reason: string }
  | {
      readonly nudge: false
      readonly reason: string
      readonly considered: boolean
      /** Set when a family matched but its budget was spent. */
      readonly exhausted?: Kind
    }

/**
 * The whole decision, in one place and with no I/O, so every condition can be
 * read - and tested - without a session, a provider or a stream.
 */
export function decide(input: Decision): Verdict {
  // origami_change (t-53vyxf): the kill switch, checked before the provider so
  // "off" is off for every provider and no later gate can be read as the reason.
  if (input.enabled === false)
    return { nudge: false, considered: false, reason: "the continuation nudge is off" }
  if (input.providerID !== PROVIDER)
    return { nudge: false, considered: false, reason: `provider ${input.providerID} is not ${PROVIDER}` }
  if (input.finish !== "stop")
    return { nudge: false, considered: false, reason: `finish ${input.finish ?? "unset"} is not stop` }
  if (input.hasToolCallThisStep) return { nudge: false, considered: false, reason: "the step made a tool call" }
  if (!input.sawToolCallThisTurn)
    return { nudge: false, considered: false, reason: "no tool has run in this turn" }

  const promise = isContinueIntent(input.prose)
  const remaining = !promise && statesRemainingWork(input.prose)
  if (!promise && !remaining) return { nudge: false, considered: true, reason: "the tail claims nothing" }
  const kind: Kind = promise ? "promise" : "remaining"
  if (input.nudges >= LIMIT) {
    return { nudge: false, considered: true, exhausted: kind, reason: `${kind} tail matched but ${input.nudges} nudges are spent` }
  }
  return {
    nudge: true,
    kind,
    instruction: promise ? INSTRUCTION : REMAINING_INSTRUCTION,
    reason: promise ? "the tail promises to continue" : "the tail states work remains",
  }
}

export * as SessionContinueNudge from "./continue-nudge"
