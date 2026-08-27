// activeSession.ts — which session a host-side request resolves to, when the
// stored "active" id may name one that is GONE.
//
// THE CORPSE (W8-L1, live UAT). `this.activeSessionId` is set the moment a
// session is registered, before its engine is up. A session created AS a bot
// whose definition the engine refuses is then DELETED from the session map on
// the failure path — and that path is not `closeSession`, so nothing moved the
// active id off it. The window was left pointing at a session that no longer
// exists while two healthy chats sat beside it.
//
// What that looked like: the SKILLS pane answering "Open a chat first — listing
// skills needs an active session" with two chats open and working. It surfaced
// there and only there because every other pane already wrote its own fallback
// inline (`getActiveSession() ?? [...sessions.values()][0]`) and skills did not.
// A per-caller fallback cannot be the fix: it leaves the stale id in place for
// the next reader, and it is a rule fifteen call sites are each free to forget.
//
// So the rule is named ONCE here, and it is the rule `closeSession` already
// applied when a chat was closed properly: keep the stored id while it names a
// live session, otherwise fall to the newest survivor, otherwise nothing.
//
// Pure — no `vscode`, no I/O — so both halves are exercised on a plain Map.

/**
 * The active session id, REPAIRED.
 *
 * `current` when it still names a live session. Otherwise the last key of
 * `sessions`, which is the newest surviving chat (a Map iterates in insertion
 * order and sessions are inserted as they are created) — the same choice
 * `closeSession` makes when the user closes the chat they were in. `null` when
 * nothing is left.
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
 * The SESSION a request answers from, or undefined when this window holds none.
 *
 * The read half of the rule above. A caller that gets `undefined` here really
 * has no chat open, so "open a chat first" is the truth rather than a symptom.
 */
export function liveActiveSession<T>(
  sessions: ReadonlyMap<string, T>,
  current: string | null | undefined,
): T | undefined {
  const id = liveActiveSessionId(sessions, current);
  return id === null ? undefined : sessions.get(id);
}
