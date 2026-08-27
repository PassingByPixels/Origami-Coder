import { EOL } from "os"

// `origami run` printed session errors only for its OWN session, so a subagent's
// failure never reached the output - and therefore never reached a cron's log.
//
// The task tool does surface most child failures to the parent as <task_error>, but
// not all of them: it only inspects `result.info.error` on the returned assistant
// message, and at least two paths publish a session error WITHOUT setting it -
// - session/processor.ts, ContextOverflowError with auto-compaction: publishes the
//   error, sets ctx.needsCompaction and returns, leaving assistantMessage.error unset.
// - session/prompt.ts, the max-steps backstop: publishes the error, then `break`s the
//   step loop instead of throwing, so the turn returns normally and the task tool
//   reports SUCCESS with partial work.
// A subagent that runs out of steps therefore tells its parent it succeeded. That is
// the false-green this makes visible.
//
// Visibility only. The exit code still reflects whether the RUN succeeded, which only
// the parent can judge: a parent that receives a <task_error>, recovers and completes
// its objective has genuinely succeeded, and failing the run there would report
// failure for work that worked - training everyone to ignore the exit code.

type ErrorLike = {
  readonly name?: unknown
  readonly data?: unknown
}

export type SessionErrorReport = {
  /** Message to print - already attributed when it came from a subagent. */
  readonly text: string
  /** True only for the RUN session's own error: the only kind that sets the exit code. */
  readonly own: boolean
}

function message(error: ErrorLike) {
  const data = error.data
  if (data && typeof data === "object" && "message" in data) {
    const inner = (data as Record<string, unknown>).message
    if (inner !== undefined && inner !== null) return String(inner)
  }
  return String(error.name)
}

/**
 * Decide whether a `session.error` belongs to this run and how to report it.
 * Returns undefined for an unrelated session - those are not ours to print.
 */
export async function resolveSessionError(input: {
  // sessionID is optional on the wire; an error we cannot attribute to a session is
  // not one we can claim, so it is left alone exactly as before.
  event: { readonly sessionID?: string; readonly error?: ErrorLike }
  runSessionID: string
  isDescendant: (sessionID: string) => Promise<boolean>
}): Promise<SessionErrorReport | undefined> {
  const error = input.event.error
  const from = input.event.sessionID
  if (!error || !from) return undefined

  const own = from === input.runSessionID
  if (!own && !(await input.isDescendant(from))) return undefined

  const text = message(error)
  if (own) return { text, own: true }
  return { text: `subagent ${from}: ${text}`, own: false }
}

/**
 * Fold a report into the run's exit-code error. Subagent failures are reported but
 * never decide the run's fate - keeping this in one place is what stops the two rules
 * drifting apart.
 */
export function accumulateExitError(current: string | undefined, report: SessionErrorReport) {
  if (!report.own) return current
  return current ? current + EOL + report.text : report.text
}
