// Apply a user-chosen chat order to the live sessions map: the sidebar Chats list has no
// order field of its own, so "reorder" means rebuilding the map's insertion order (which
// both the sessions projection and open-set persistence read directly). Invariant: a reorder
// must never lose a session — the order may be a moment stale, so anything it fails to name
// is kept, not dropped.

/** Rank live entries by a webview-supplied id order. Unknown or repeated ids are ignored;
 *  entries the order never named keep their relative order at the tail. Returns null when
 *  the order names nothing live — a wholly stale drag, where the honest action is to leave
 *  the map untouched. */
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
