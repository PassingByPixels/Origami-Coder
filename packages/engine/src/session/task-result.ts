/**
 * The contract for the synthetic turn a finished BACKGROUND sub-agent injects
 * into its parent session (tool/task.ts `drain`), and the only thing that tells
 * a client "that child is done".
 *
 * WHY A PART METADATA STAMP. The launcher `task` call returns the instant the
 * child is spawned, so its tool card reaches `completed` while the child is
 * still working. The child's REAL completion arrives minutes later as this
 * injected turn, whose text is an XML-ish `<task ...><task_result>` blob meant
 * for the MODEL. A client that wanted the same fact had to parse that blob;
 * stamping the part instead keeps the machine-readable answer out of the prose.
 *
 * WHY A LIST. The drainer folds every sibling that finished during one turn
 * into ONE injected turn (that batching is the whole point of the drainer), so
 * one part can settle several children at once. The text stays exactly what the
 * model saw before this stamp existed.
 */

/** Key on the injected text part's `metadata`. */
export const TASK_RESULTS_KEY = "origami_task_results"

export type TaskResultState = "completed" | "error"

export type TaskResultEntry = {
  /** The sub-agent SESSION id — the same id `_meta.origami_task_session` rides
   *  on the launcher's tool updates, which is how a client joins the two. */
  sessionId: string
  state: TaskResultState
}

/** The part `metadata` object carrying these entries. */
export function taskResultsMetadata(entries: readonly TaskResultEntry[]) {
  return { [TASK_RESULTS_KEY]: entries.map((entry) => ({ sessionId: entry.sessionId, state: entry.state })) }
}

/**
 * The entries carried by a part's metadata, or `[]` for every other part.
 * Fail-closed per entry: an entry whose shape is not exactly what
 * `taskResultsMetadata` writes is dropped rather than guessed at, because a
 * malformed one would retire a live row and stop anybody watching that child.
 */
export function taskResults(metadata: unknown): TaskResultEntry[] {
  if (!metadata || typeof metadata !== "object") return []
  const raw = (metadata as Record<string, unknown>)[TASK_RESULTS_KEY]
  if (!Array.isArray(raw)) return []
  const entries: TaskResultEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const { sessionId, state } = item as { sessionId?: unknown; state?: unknown }
    if (typeof sessionId !== "string" || !sessionId) continue
    if (state !== "completed" && state !== "error") continue
    entries.push({ sessionId, state })
  }
  return entries
}
