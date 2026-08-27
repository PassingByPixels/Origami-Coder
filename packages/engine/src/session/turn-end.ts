/**
 * The `origami/turnEnd` notification: what the engine says when a turn reaches
 * a TERMINAL verdict, and the process-local channel it travels on.
 *
 * WHY A MIRROR FILE. The client half of this notification was built first and
 * has been sitting dark: `packages/vscode/src/acpClient.ts` declares the
 * handler (`onTurnEnd`, ~:200-211), decodes the wire payload (~:1294-1310),
 * `dashboard/DashboardPanel.ts` (~:1749-1755) forwards it, and
 * `webview/dashboard/panes/turnVerdict.ts` renders the taxonomy. Nothing in
 * the engine ever emitted it. This module is the ENGINE's statement of that
 * contract, kept in one place so the two ends cannot drift silently — see
 * `test/session/turn-end.test.ts`, which fails if either the method name, the
 * payload key or the taxonomy moves.
 *
 * WHY A PROCESS-LOCAL BROKER RATHER THAN AN EVENT. The verdict is produced in
 * the SESSION layer (session/goal.ts), asynchronously, after the turn the ACP
 * `prompt` call already returned for — so it cannot ride the prompt response.
 * The other route, a published EventV2, would have to be a new PUBLIC wire type
 * in `@origami/schema` and the SDK's `Event` union, for a value only the ACP
 * shell reads. The ACP service boots the engine IN-PROCESS (cli/cmd/acp.ts), so
 * a plain module-level listener list reaches it directly — the same reasoning,
 * and the same plain module state, as the peer-message ledger next door.
 */

/**
 * The JSON-RPC method. `acpClient.ts` strips a single leading `_` before it
 * switches, so `_origami/turnEnd` and `origami/turnEnd` both decode; the
 * unprefixed spelling is what `origami/todoSnapshot` already sends
 * (acp/service.ts `replayTodos`).
 */
export const TURN_END_METHOD = "origami/turnEnd"

/**
 * The taxonomy, verbatim from the client's `verdictForStopReason`
 * (packages/vscode/webview/dashboard/panes/turnVerdict.ts). `success` is the
 * ONLY verified-done; `asked_user` is parked; everything else is incomplete.
 * A label outside this list renders as `unknown` on the client and is never
 * promoted to a benign verdict, which is why the engine must not invent one.
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
 * else — the decode reads no session id, and one `AcpClient` is constructed
 * per chat (DashboardPanel.ts `session.client = new AcpClient(handlers)`), so
 * the connection itself is the routing.
 */
export function turnEndPayload(stopReason: StopReason): { stop_reason: StopReason } {
  return { stop_reason: stopReason }
}

export type TurnEndListener = (input: { sessionID: string; stopReason: StopReason }) => void

/** Plain module state, like the peer-message ledger's: the session layer that
 *  publishes and the ACP shell that forwards both run in THIS process. */
const listeners = new Set<TurnEndListener>()

/** Register a sink. Returns the unsubscribe. */
export function onTurnEnd(listener: TurnEndListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Announce a terminal verdict. Best-effort by construction: a client with no
 * `extNotification`, or a sink that throws, must never take down the turn that
 * produced the verdict — the verdict is a UI signal, not a result.
 */
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
