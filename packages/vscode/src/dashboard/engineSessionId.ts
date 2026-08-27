// The ONE place a chat's ENGINE session id is resolved for a message that
// crosses the ACP wire. Every session-scoped ext-method — interject,
// shell_stop, plan_action — is looked up in the ENGINE's own session map, and
// the id the webview holds is not in it.
//
// The failure this leaf makes unrepresentable shipped in 0.4.12, and a user's
// exported transcript ends on it:
//
//     [!ERROR] Interject failed: Invalid params: session not found: session-3
//
// The webview names its chats session-1, session-2, … (DashboardPanel.ts mints
// them, `const sessionId = ...`), while the engine names its own sessions.
// 0.4.14 fixed interject/shell_stop by reading AcpClient.currentSessionId; this
// states the same rule once, for every wire-bound control message, and deletes
// the fallback that survived it (`currentSessionId ?? sid`, on plan_action).
//
// There is deliberately NO fallback. When the engine id is missing, the local
// id is not a weaker answer, it is a WRONG one: it produces the raw engine
// error above instead of a sentence the caller can turn into a reason. A null
// return is the caller's cue to say so.
//
// It takes the CLIENT the caller already looked up in DashboardPanel.sessions
// (local id -> Session -> client) rather than keeping a second local-to-engine
// map of its own: a second copy of that pairing is a second thing to drift.

/** The identity half of AcpClient, declared structurally: acpClient.ts is at
 *  its own cap, and every other leaf here (promptCapture, cacheStats,
 *  turnMessages) declares the same shape for the same reason. */
export interface EngineSessionSource {
  /** The ENGINE's session id, null until the handshake completes. */
  readonly currentSessionId: string | null;
}

/** The webview's own id format, MIRRORED from DashboardPanel.ts's local-id
 *  mint. engineSessionId.test.ts reads both files and fails if the mint changes
 *  shape without this following it. */
const LOCAL_ID = /^session-\d+$/;

/** True for an id the WEBVIEW minted. Nothing the engine mints matches it. */
export function isLocalSessionId(id: string): boolean {
  return LOCAL_ID.test(id);
}

/**
 * The engine id to put on the wire for the chat the webview named, or null when
 * there is none to send.
 *
 * `localId` is passed only so it can be REFUSED: an engine id that equals the
 * webview's own id did not come from the engine. That is not hypothetical —
 * `AcpClient.start()` assigns `this.sessionId = loadSessionId` verbatim, so a
 * recall path that ever passed a local id would smuggle one into
 * `currentSessionId`, and this boundary is where it stops.
 */
export function engineSessionId(
  client: EngineSessionSource | null | undefined,
  localId?: string | null,
): string | null {
  const engine = client?.currentSessionId ?? null;
  if (!engine) return null;
  if (isLocalSessionId(engine) || (localId != null && engine === localId)) return null;
  return engine;
}
