// runningChildren.ts — the row-array reducers behind the ring's FOURTH input
// (sessionRowState.ts's `subagentsRunning`). A LEAF, sibling of
// sessionRowState.ts and chatSections.ts, pulled out so ChatsList.svelte's
// message switch stays one line per case instead of an inline `.map` per
// case (ChatsList.svelte sits at its architecture cap — see the entry below).
//
// Mirrors subagentEntry.ts's `stillOut` rule for a BACKGROUND `task` card so
// the drawer's roster and this ring input can never disagree about whether a
// child is still out: tracked on a `toolResult` spawn, cleared on the
// engine's one terminal marker (`subagentDone`) — never on the parent's own
// turn ending, which is the whole point of the state this feeds.

interface TrackedRow { id: string; runningChildren: ReadonlySet<string> }

/** `toolResult`: a still-out BACKGROUND `task` spawn, tracked against its
 *  PARENT session. A no-op for anything else — a foreground task, a
 *  toolResult for an unrelated tool, or one missing either id. */
export function trackSpawnedChild<T extends TrackedRow>(rows: T[], msg: Record<string, unknown>): T[] {
  const cid = msg.taskSessionId;
  const sid = msg.sessionId;
  if (typeof cid !== 'string' || !cid || typeof sid !== 'string' || msg.toolName !== 'task' || msg.taskBackground !== true) return rows;
  return rows.map((r) => (r.id === sid && !r.runningChildren.has(cid)) ? { ...r, runningChildren: new Set(r.runningChildren).add(cid) } : r);
}

/** `subagentDone`: the engine's one terminal marker for a background child —
 *  what retires it. A no-op if it was never tracked, or the ids are missing. */
export function clearDoneChild<T extends TrackedRow>(rows: T[], msg: Record<string, unknown>): T[] {
  const cid = msg.taskSessionId;
  const sid = msg.sessionId;
  if (typeof cid !== 'string' || !cid || typeof sid !== 'string') return rows;
  return rows.map((r) => {
    if (r.id !== sid || !r.runningChildren.has(cid)) return r;
    const next = new Set(r.runningChildren);
    next.delete(cid);
    return { ...r, runningChildren: next };
  });
}
