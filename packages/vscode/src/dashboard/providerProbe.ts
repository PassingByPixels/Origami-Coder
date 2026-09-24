// The fan-out half of broadcastProviderStatus: run every configured provider's liveness probe AT
// THE SAME TIME, with per-provider isolation and a bound on how long any one may hold the batch.
//
// Extracted from a sequential for-loop that summed every provider's latency and let one unreachable
// remote stall the whole post — the same defect liveModelMerge.ts fixes for the sibling
// modelOptions broadcast.
//
// Stays generic (no provider vocabulary) so it is testable without a vscode host; the concurrency,
// isolation and bound are asserted directly in providerProbe.test.ts.

/**
 * Hard ceiling on ONE provider's liveness probe — not a latency target. Every probe already carries
 *  its own transport timeout, so this bound only catches what those miss: a socket that connects
 *  and then dribbles, never tripping an inactivity timeout, which would otherwise hold the whole
 *  providerStatus post open indefinitely.
 */
export const PROVIDER_PROBE_TIMEOUT_MS = 10000;

/**
 * Run `probe` for every item CONCURRENTLY, preserving input order.
 * Isolation: a probe that rejects costs only its own entry via `onFailure`; every neighbour still
 *  returns its real answer.
 * Bound: a probe that never settles is abandoned after `timeoutMs` and also takes `onFailure`, so
 *  one dribbling socket cannot hold the batch open.
 */
export async function probeConcurrently<T, R>(
  items: readonly T[],
  probe: (item: T) => Promise<R>,
  onFailure: (item: T, reason: string) => R,
  timeoutMs: number,
): Promise<R[]> {
  return Promise.all(
    items.map(async (item) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (timeoutMs <= 0) return await probe(item);
        return await Promise.race([
          probe(item),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
      } catch (e) {
        return onFailure(item, e instanceof Error ? e.message : String(e));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
}
