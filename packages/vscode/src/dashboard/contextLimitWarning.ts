// The user-visible half of a context-limit finding: writeModelContextLimit (firstFold.ts) bridges a
// PROBED context window to the engine, and its failure used to be silent both in the writer and at
// the two call sites that discarded its boolean.
//
// The engine resolves `model.limit?.context ?? 0`, and overflow.ts hard-returns false from
// isOverflow() at context 0 — so a probe that measured the window correctly but failed to persist
// it leaves auto-compaction OFF for that model, with nothing anywhere saying why.
//
// This leaf owns the once-per-model user line so the panel doesn't repeat it on every probe tick.

/** Post a webview message. Matches DashboardPanel's `post(msg: object)`. */
export type PostFn = (m: object) => void;

/** Model keys already reported, so a probe that runs every few seconds says it
 *  once. Module-level: the point is one line per model per window, and there is
 *  exactly one extension host per window. */
const warned = new Set<string>();

/**
 * Build the `onError` callback for one `writeModelContextLimit` call.
 * Fires at most once per `providerId/modelId`.
 */
export function contextLimitWarner(
  post: PostFn,
  sessionId: string,
  providerId: string,
  modelId: string,
): (message: string) => void {
  return (message: string) => {
    const key = `${providerId}/${modelId}`;
    if (warned.has(key)) return;
    warned.add(key);
    post({
      type: 'system',
      text: `Could not save the measured context window for \`${key}\` — auto-compaction stays OFF `
        + `for it, so a long chat will hit a provider-side overflow instead of compacting. ${message}`,
      sessionId,
    });
  };
}

/** Test hook — the dedupe set is module state by design. */
export function resetContextLimitWarnings(): void {
  warned.clear();
}
