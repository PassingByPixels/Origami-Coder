// activeSession.ts — resolves which session a host-side request should use
// when the stored "active" id may name a session that no longer exists.
//
// The rule is named ONCE here rather than left to each caller's own fallback,
// so a stale active id cannot silently strand a pane. Pure — no vscode, no I/O.

/**
 * The active session id, repaired: `current` when it still names a live
 * session, otherwise the newest surviving session, otherwise null.
 */
export function liveActiveSessionId(
  sessions: ReadonlyMap<string, unknown>,
  current: string | null | undefined,
): string | null {
  if (current && sessions.has(current)) return current;
  const ids = [...sessions.keys()];
  return ids.length > 0 ? ids[ids.length - 1]! : null;
}

/**
 * The session a request should use, or undefined when this window holds
 * none open.
 */
export function liveActiveSession<T>(
  sessions: ReadonlyMap<string, T>,
  current: string | null | undefined,
): T | undefined {
  const id = liveActiveSessionId(sessions, current);
  return id === null ? undefined : sessions.get(id);
}
