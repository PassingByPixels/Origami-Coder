/**
 * t-v4qvq1: the child todo nudge. A sub-agent (a session with a `parentID`)
 * that ends its turn with `finish: "stop"` while its OWN todo list still has
 * open items is asked once to carry on, inside the same turn.
 *
 * Why: owner stress test 2026-09-24. A reader child (opencode-go) wrote a todo
 * list, read 8 of 78 files and stopped with the list open. No engine limit was
 * hit. The parent resumed it 9 times, one or two files per resume. The OpenAI
 * continuation nudge (`session/continue-nudge.ts`) is provider-scoped and never
 * fired; goal mode runs only for a primary session; the todo reminders in
 * `session/reminders.ts` speak at the start of a step, never at the turn end.
 *
 * The open list is the signal here, not the prose. That is the signal
 * `continue-nudge.ts` rejected for a primary session ("turns the model's own
 * planning note into a contract"). A child is different: nobody reads its turn
 * end except the parent, which must then spend a turn of its own to resume it.
 *
 * Bounds, all required:
 *   - the session is a child;
 *   - the step finished `"stop"` with no tool call, and is not a summary or an
 *     error;
 *   - a tool ran in this turn (the child made progress). A turn that stops with
 *     no work done is not nudged, so a child that ignores the nudge and stops
 *     again on the next resume costs nothing more;
 *   - the child's stored todo list has an open item;
 *   - no continuation nudge of any kind was sent in this turn. `LIMIT` is one.
 * Worst case is one extra step per turn. The nudge is a new user turn appended
 * at the end; no sent message is changed, so the cached prefix is kept.
 */

/** Nudges one child turn may spend. One: a second stop is the child's answer. */
export const LIMIT = 1

/**
 * Marks the injected part in the stored transcript. A separate key from
 * `origami_continue_nudge`, so a count of one family never includes the other.
 */
export const METADATA_KEY = "origami_child_todo_nudge"

/**
 * Statuses that mean the item is not open work. The same three names as
 * `TERMINAL` in packages/core/src/session/todo-reconcile.ts and `TODO_CLOSED`
 * in session/reminders.ts.
 */
const CLOSED = new Set(["completed", "cancelled", "failed"])

/** Items of the list that are still open work. */
export function openCount(todos: readonly { readonly status: string }[]): number {
  return todos.filter((todo) => !CLOSED.has(todo.status)).length
}

/**
 * The body of the injected turn. The byline is the `<engine-note>` shape of
 * `continue-nudge.ts`. The last sentence is there because the parent receives
 * only the child's final reply: a partial report written before the nudge is
 * not what the parent reads.
 */
export const TEXT =
  "<engine-note>The Origami engine wrote this line, not the user. " +
  "You ended your turn while your todo list still has open items.</engine-note>\n" +
  "Continue with the open items now, one tool call at a time. " +
  "If an item cannot be done, mark it cancelled with todowrite and say why. " +
  "Your final reply is the only text the parent agent receives, so put your complete result in it."

export type Decision = {
  /** The session has a parent: it is a sub-agent. */
  readonly child: boolean
  readonly finish: string | undefined
  /** This step committed a tool call - the exit gate's own test. */
  readonly hasToolCallThisStep: boolean
  /** An earlier step of this turn ran a tool. */
  readonly sawToolCallThisTurn: boolean
  /** The step is a compaction summary or carries an error. */
  readonly summaryOrError: boolean
  /** Open items in the child's stored todo list. */
  readonly open: number
  /** Child todo nudges already sent in this turn. */
  readonly nudges: number
  /** Continuation nudges of the OpenAI family already sent in this turn. */
  readonly otherNudges: number
  /** `ORIGAMI_CONTINUE_NUDGE=off` silences this family too. Absent means on. */
  readonly enabled?: boolean
}

export type Verdict = { readonly nudge: boolean; readonly reason: string }

/** The whole decision, with no I/O. */
export function decide(input: Decision): Verdict {
  if (input.enabled === false) return { nudge: false, reason: "continuation nudges are off" }
  if (!input.child) return { nudge: false, reason: "not a child session" }
  if (input.finish !== "stop") return { nudge: false, reason: `finish ${input.finish ?? "unset"} is not stop` }
  if (input.hasToolCallThisStep) return { nudge: false, reason: "the step made a tool call" }
  if (input.summaryOrError) return { nudge: false, reason: "the step is a summary or an error" }
  if (!input.sawToolCallThisTurn) return { nudge: false, reason: "no tool has run in this turn" }
  if (input.open === 0) return { nudge: false, reason: "the todo list has no open item" }
  if (input.otherNudges > 0) return { nudge: false, reason: "a continuation nudge was already sent this turn" }
  if (input.nudges >= LIMIT) return { nudge: false, reason: `${input.nudges} child todo nudge already sent` }
  return { nudge: true, reason: `${input.open} todo item(s) still open` }
}

export * as SessionChildTodoNudge from "./child-todo-nudge"
