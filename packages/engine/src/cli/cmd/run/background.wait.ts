// A background subagent is DETACHED: the task tool returns "running" immediately, so
// the parent's turn ends and the run session goes idle while the child is still
// working. Breaking the event loop at that first idle tears the process down and
// aborts the child mid-turn - observed as MessageAbortedError on the child's
// assistant message with nothing written to disk, while the parent had already
// reported the task launched.
//
// So track the background children this run launched and keep draining events until
// they settle. That is not a courtesy: a finished background subagent injects its
// result back into the PARENT session as a fresh turn, so exiting at first idle
// abandons both the child's work and the turn that reports it.
//
// The wait is bounded by the caller. An unbounded one would only move the hang.

/** Bounds how long a run waits for detached children AFTER its own turn finished. */
export const DEFAULT_BACKGROUND_WAIT_MS = 300_000

export type BackgroundLaunch = {
  readonly sessionID: string
  readonly description: string
}

// `state` is a union whose pending arm carries neither title nor metadata, so it is
// taken loosely and narrowed here rather than constraining callers to one arm.
type ToolPartLike = {
  readonly type: string
  readonly tool?: string
  readonly state?: unknown
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  return (value as Record<string, unknown>)[key]
}

/**
 * Recognise a task tool part that launched a DETACHED subagent. The task tool stamps
 * `background: true` on both the running part (via ctx.metadata) and the completed
 * one, naming the child session as `jobId` (completed) or `sessionId` (running) -
 * both are the child's session id, so either identifies it.
 */
export function backgroundLaunch(part: ToolPartLike): BackgroundLaunch | undefined {
  if (part.type !== "tool" || part.tool !== "task") return undefined

  const metadata = field(part.state, "metadata")
  if (!metadata || typeof metadata !== "object") return undefined
  if (field(metadata, "background") !== true) return undefined

  const jobId = field(metadata, "jobId")
  const legacyId = field(metadata, "sessionId")
  const sessionID = typeof jobId === "string" ? jobId : typeof legacyId === "string" ? legacyId : undefined
  if (!sessionID) return undefined

  const title = field(part.state, "title")
  return { sessionID, description: typeof title === "string" && title ? title : sessionID }
}

export type BackgroundTracker = {
  track(launch: BackgroundLaunch): void
  settle(sessionID: string): boolean
  outstanding(): BackgroundLaunch[]
  size(): number
}

export function createBackgroundTracker(): BackgroundTracker {
  const pending = new Map<string, string>()
  return {
    track: (launch) => {
      pending.set(launch.sessionID, launch.description)
    },
    settle: (sessionID) => pending.delete(sessionID),
    outstanding: () => [...pending].map(([sessionID, description]) => ({ sessionID, description })),
    size: () => pending.size,
  }
}

/**
 * Fold one `session.status` idle event into the tracker and say whether the run may
 * stop. Stopping is only ever correct when the RUN session is idle AND no detached
 * child is still outstanding.
 */
export function observeIdle(
  tracker: BackgroundTracker,
  input: { idleSessionID: string; runSessionID: string },
): "continue" | "stop" {
  tracker.settle(input.idleSessionID)
  if (input.idleSessionID !== input.runSessionID) return "continue"
  return tracker.size() === 0 ? "stop" : "continue"
}

export function describeOutstanding(tracker: BackgroundTracker) {
  return tracker
    .outstanding()
    .map((item) => `${item.description} (${item.sessionID})`)
    .join(", ")
}
