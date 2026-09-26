/**
 * t-xsufpe: the plan exit nudge. A plan-mode turn (plan agent, native plan
 * mode on) that is about to end with a text answer and no `plan_exit` call is
 * asked ONCE, inside the same turn, to write the plan file and call
 * `plan_exit`, or to ask its open question with the question tool.
 *
 * Why: owner UAT of 0.4.178. GLM-5.3-Flash wrote the plan as chat text, so the
 * plan review (approve / revise) never started.
 *
 * Bounds, all required:
 *   - the turn's agent is `plan` and native plan mode is on;
 *   - the step finished `"stop"` with no tool call, and is not a summary or an
 *     error, and has text;
 *   - neither `plan_exit` nor `question` was called in this turn;
 *   - no nudge of this family was sent in this turn (`LIMIT` is one).
 * The nudge is a new synthetic user turn appended at the end; no sent message
 * is changed. Its text depends only on the plan path, so two runs of the same
 * session send the same bytes.
 */

/** Nudges one plan turn may spend. One: a second text stop is the model's answer. */
export const LIMIT = 1

/** Marks the injected part in the stored transcript. */
export const METADATA_KEY = "origami_plan_exit_nudge"

/** True when a tool of this turn already ended it the way plan mode wants. */
export function endedByTool(tools: readonly string[]): boolean {
  return tools.some((tool) => tool === "plan_exit" || tool === "question")
}

/** The body of the injected turn. `plan` is the session's plan file path. */
export function text(plan: string): string {
  return (
    "<engine-note>The Origami engine wrote this line, not the user. " +
    "You ended a plan-mode turn with a text answer and did not call plan_exit.</engine-note>\n" +
    `If your plan is ready: write it to ${plan} and then call plan_exit, so the user can approve or revise it. ` +
    "If you need an answer from the user first: ask with the question tool."
  )
}

export type Decision = {
  /** The turn's agent name. */
  readonly agent: string
  /** `RuntimeFlags.experimentalPlanMode`. */
  readonly planMode: boolean
  readonly finish: string | undefined
  /** This step committed a tool call. */
  readonly hasToolCallThisStep: boolean
  /** The step is a compaction summary or carries an error. */
  readonly summaryOrError: boolean
  /** The step's text. */
  readonly prose: string
  /** Tool names called in this turn. */
  readonly toolsThisTurn: readonly string[]
  /** Plan exit nudges already sent in this turn. */
  readonly nudges: number
}

export type Verdict = { readonly nudge: boolean; readonly reason: string }

/** The whole decision, with no I/O. */
export function decide(input: Decision): Verdict {
  if (input.agent !== "plan") return { nudge: false, reason: "not the plan agent" }
  if (!input.planMode) return { nudge: false, reason: "native plan mode is off" }
  if (input.finish !== "stop") return { nudge: false, reason: `finish ${input.finish ?? "unset"} is not stop` }
  if (input.hasToolCallThisStep) return { nudge: false, reason: "the step made a tool call" }
  if (input.summaryOrError) return { nudge: false, reason: "the step is a summary or an error" }
  if (input.prose.trim() === "") return { nudge: false, reason: "the step has no text" }
  if (endedByTool(input.toolsThisTurn)) return { nudge: false, reason: "plan_exit or question was called this turn" }
  if (input.nudges >= LIMIT) return { nudge: false, reason: `${input.nudges} plan exit nudge already sent` }
  return { nudge: true, reason: "plan turn ended in text without plan_exit" }
}

export * as SessionPlanExitNudge from "./plan-exit-nudge"
