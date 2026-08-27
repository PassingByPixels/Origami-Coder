// sessionOrder.ts — apply a user-chosen chat order to the live sessions map.
//
// The sidebar Chats list has no order field of its own: the order IS the
// sessions Map's insertion order, which both the requestSessions projection and
// the open-set persistence (sessionRestore.computeOpenSet) read straight off the
// map. So "reorder the chats" means rebuilding that map, and the rule for doing
// it safely lives here rather than inline in the panel — sessionRestore.ts, its
// natural sibling, had 8 lines under its architecture cap.
//
// The one invariant worth a module: a reorder must never LOSE a session. The
// order arrives from a webview that may be a moment stale (a chat opened, or an
// Agent Manager worktree session created, after the list it dragged was drawn),
// so anything the order fails to name is kept rather than dropped.

/** Rank the live entries by a webview-supplied id order.
 *
 *  Ids that are unknown to the map, or repeated in the order, are ignored. Live
 *  entries the order never named keep their relative order at the TAIL, so a
 *  session created mid-drag survives a stale order instead of vanishing.
 *
 *  Returns null when the order names nothing live at all — a wholly stale drag,
 *  where the honest action is to leave the map untouched rather than reshuffle
 *  it into an order the user never asked for.
 */
export function rankEntries<T>(
  entries: Iterable<[string, T]>,
  order: readonly string[],
): Array<[string, T]> | null {
  const live = new Map<string, T>(entries);
  const ranked: Array<[string, T]> = [];
  for (const id of order) {
    if (!live.has(id)) continue; // unknown, or already consumed by an earlier repeat
    ranked.push([id, live.get(id) as T]);
    live.delete(id);
  }
  if (ranked.length === 0) return null;
  for (const rest of live) ranked.push(rest);
  return ranked;
}
