/**
 * The side-quest per-turn budget: which turn each session last spent it on.
 *
 * Its own leaf module, importing NOTHING. The map lives with the tool
 * (tool/side-quest.ts) but `Session.remove` has to drop a session's entry, and
 * importing the tool from the session store pulls `tool/tool.ts` -> `agent` ->
 * `plugin` back into a cycle that fails at module init (t-fijy8a F9: the ACP
 * suite caught it as "Cannot access 'node' before initialization").
 */

const spent = new Map<string, string>()

/**
 * Take this turn's budget for `sessionID`, or report it already spent.
 *
 * CLAIMED, not spent at the end: two tool calls the model made in parallel
 * would both be past the check before either had written a file, so the budget
 * is taken here, synchronously, before any I/O.
 */
export function claim(sessionID: string, turn: string): boolean {
  if (spent.get(sessionID) === turn) return false
  spent.set(sessionID, turn)
  return true
}

/** t-fijy8a F9. One entry per session is still one entry per session FOREVER:
 *  nothing dropped a chat that was deleted. Called from `Session.remove`,
 *  beside `TaskResult.forget`. */
export function forget(sessionID: string): void {
  spent.delete(sessionID)
}
