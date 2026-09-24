// Resolves the ENGINE's session id for any session-scoped ext-method (interject, shell_stop,
// plan_action) — the webview's own local id (session-1, session-2, …) is never in the engine's
// session map.
//
// Deliberately NO fallback: a missing engine id is a wrong answer to guess at, not a weaker one —
// it produces a raw engine error instead of a message the caller can turn into a reason. Takes the
// client the caller already resolved rather than keeping a second local-to-engine map, so there is
// only one place this pairing can drift.

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
 * The engine id to put on the wire for the chat the webview named, or null when there is none to
 *  send.
 * `localId` is passed only so it can be refused: an id equal to the webview's own local id did not
 *  come from the engine, and letting one through would smuggle a local id into `currentSessionId`.
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
