// origami_change (t-z1xlfy): the agent map's live data.
//
// The client builds its sub-agent roster from THIS chat's `task` cards. A
// grandchild's `task` card lives in the child's session, so the client never saw
// one: the map drew one tier. Two facts now reach the client live, both under the
// registered ancestor (the only session id the client knows):
//
// 1. The roster (`origami/subagentRoster`: parent id + depth of every descendant),
//    re-sent when any descendant's status changes. Coalesced per chat, because a
//    fan-out of 20 children changes status 40 times in a second.
// 2. A sub-agent's background shell (`origami/backgroundTask`): start and stop,
//    with its owner. The chat's OWN background shells already reach their tool
//    card (acp/event.ts `handleShellTelemetry`), so only descendants' are sent.
//
// Neither touches a request to the model: both are client notifications.

/** Wait after the last status change before the roster is read and sent. */
export const ROSTER_DEBOUNCE_MS = 250

export const BACKGROUND_TASK_METHOD = "origami/backgroundTask"

export type BackgroundTask = {
  /** The registered chat the task is shown under. */
  sessionId: string
  /** The sub-agent session that started it. */
  ownerSessionId: string
  jobId: string
  kind: "shell"
  title: string
  status: "running" | "completed" | "error" | "cancelled"
  startedAt: number
  endedAt?: number
}

/** One pending roster send per chat, the last change wins. */
export class RosterDebounce {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly send: (sessionId: string, cwd: string) => Promise<void>,
    private readonly delayMs = ROSTER_DEBOUNCE_MS,
  ) {}

  schedule(sessionId: string, cwd: string) {
    const was = this.timers.get(sessionId)
    if (was) clearTimeout(was)
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId)
        void this.send(sessionId, cwd).catch(() => {})
      }, this.delayMs),
    )
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

/** The telemetry frame of a descendant's background shell as a map chip. A
 *  foreground shell is not a background task, so it returns undefined. */
export function backgroundTaskOf(
  sessionId: string,
  ownerSessionId: string,
  data: {
    toolCallId: string
    jobId?: string
    state: string
    status: BackgroundTask["status"]
    startedAt: number
    command?: string
  },
  now: number,
): BackgroundTask | undefined {
  if (data.state === "foreground") return undefined
  return {
    sessionId,
    ownerSessionId,
    jobId: data.jobId || data.toolCallId,
    kind: "shell",
    title: data.command ?? "",
    status: data.status,
    startedAt: data.startedAt,
    ...(data.status === "running" ? {} : { endedAt: now }),
  }
}

export * as ACPAgentTree from "./agent-tree"
