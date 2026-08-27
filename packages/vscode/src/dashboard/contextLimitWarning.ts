// The user-visible half of connections review finding 9.
//
// `writeModelContextLimit` (firstFold.ts) is the bridge that hands a PROBED
// context window to the engine. Its failure was silent in both directions: a
// blanket `catch { return false }`, and two call sites in DashboardPanel.ts
// that discard the boolean. That is not cosmetic. The engine resolves
// `model.limit?.context ?? 0`, and packages/engine/src/session/overflow.ts
// hard-returns false from `isOverflow()` at context 0 — so a probe that
// correctly measured a 262144-token window, then failed to persist it, leaves
// AUTO-COMPACTION OFF for that model. The session runs into a provider-side
// overflow instead of compacting, and nothing anywhere ever said why.
//
// The warn itself (path + error) goes to the console inside the writer. This
// leaf owns the once-per-model user line, so the panel does not repeat it on
// every probe tick.
//
// Lives in its own file because DashboardPanel.ts is at its architecture cap
// with two lines of slack — extraction first, as the house rule requires.

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
