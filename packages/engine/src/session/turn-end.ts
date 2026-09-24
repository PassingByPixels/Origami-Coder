/**
 * The `origami/turnEnd` notification: what the engine says when a turn reaches a
 * TERMINAL verdict, and the process-local channel it travels on. This is the
 * ENGINE's half of a contract whose client half already exists
 * (`vscode/src/acpClient.ts` decodes, `dashboard/DashboardPanel.ts` forwards,
 * `webview/dashboard/panes/turnVerdict.ts` renders); `test/session/turn-end.test.ts`
 * fails if the method name, the payload key or the taxonomy moves. The channel is
 * a plain module-level listener list rather than a published event: the verdict
 * lands in session/goal.ts after the ACP `prompt` call already returned, and an
 * EventV2 would mean a new PUBLIC wire type in `@origami/schema` for a value only
 * the ACP shell reads — which boots the engine IN-PROCESS (cli/cmd/acp.ts).
 */

/** The JSON-RPC method. `acpClient.ts` strips a single leading `_` before it
 *  switches, so `_origami/turnEnd` and `origami/turnEnd` both decode; the
 *  unprefixed spelling matches `origami/todoSnapshot` (acp/service.ts). */
export const TURN_END_METHOD = "origami/turnEnd"

/**
 * The taxonomy, verbatim from the client's `verdictForStopReason`
 * (webview/dashboard/panes/turnVerdict.ts). `success` is the ONLY verified-done;
 * `asked_user` is parked; everything else is incomplete. A label outside this
 * list renders as `unknown` and is never promoted to a benign verdict, so the
 * engine must not invent one.
 */
export const STOP_REASONS = [
  "success",
  "asked_user",
  "error_max_turns",
  "error_max_budget",
  "error_no_progress",
  "error_during_execution",
  "park_infra",
] as const

export type StopReason = (typeof STOP_REASONS)[number]

/**
 * The wire payload, EXACTLY as `acpClient.ts` decodes it:
 * `stopReason: String(p.stop_reason ?? '')`. One snake_case key and nothing
 * else — the decode reads no session id, and one `AcpClient` is constructed per
 * chat, so the connection itself is the routing.
 */
export function turnEndPayload(stopReason: StopReason): { stop_reason: StopReason } {
  return { stop_reason: stopReason }
}

export type TurnEndListener = (input: { sessionID: string; stopReason: StopReason }) => void

/** Plain module state: the session layer that publishes and the ACP shell that
 *  forwards both run in THIS process. */
const listeners = new Set<TurnEndListener>()

export function onTurnEnd(listener: TurnEndListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Announce a terminal verdict. Best-effort by construction: a sink that throws
 *  must never take down the turn — the verdict is a UI signal, not a result. */
export function publishTurnEnd(sessionID: string, stopReason: StopReason): void {
  for (const listener of listeners) {
    try {
      listener({ sessionID, stopReason })
    } catch {
      // deliberately swallowed; see above
    }
  }
}

/** Test seam: the listener set is process-wide, so a suite needs a way back to zero. */
export function resetTurnEndListeners(): void {
  listeners.clear()
}
