// providerProbe.ts — the fan-out half of broadcastProviderStatus: run every
// configured provider's liveness probe AT THE SAME TIME, with per-provider
// isolation and a bound on how long any one of them may hold the batch.
//
// EXTRACTED from DashboardPanel.broadcastProviderStatus, which awaited one real
// network probe per provider inside a `for` loop and only then posted a single
// `providerStatus` message. Two consequences the user actually felt when the
// model picker opened on a cold cache:
//   · wall time was the SUM of every provider's latency, not the longest one;
//   · one unreachable remote stalled the whole post, so a live LM Studio's tab
//     waited on a Spark that was powered off.
// This is the same defect, and the same shape of fix, that liveModelMerge.ts
// already applies to the sibling `modelOptions` broadcast — the two broadcasts
// now race on equal terms instead of the status one always losing.
//
// It stays generic (no provider vocabulary) for one reason: that is what makes
// it testable without a vscode host. The concurrency, the isolation and the
// bound are the whole contract, and each is asserted directly in
// providerProbe.test.ts.

/**
 * Hard ceiling on ONE provider's liveness probe.
 *
 * Not a latency target. Every probe the panel runs already carries its own
 * transport timeout (httpGetJson 4s per request, AbortSignal 12s for the
 * fetch-based ones) and the worst LEGITIMATE chain is two sequential httpGetJson
 * calls, so 10s clears any server that is merely slow — this bound can never
 * report a reachable provider as down. What it stops is the case those timeouts
 * miss: a socket that connects and then dribbles never trips an INACTIVITY
 * timeout, and before the fan-out that would have held the whole `providerStatus`
 * post — and with it the model picker's tab bar — open indefinitely.
 */
export const PROVIDER_PROBE_TIMEOUT_MS = 10000;

/**
 * Run `probe` for every item CONCURRENTLY, preserving input order.
 *
 * Isolation: a probe that REJECTS costs only its own entry — `onFailure` supplies
 * that entry's row and every neighbour still returns its real answer. (A caller
 * whose probe already resolves its own errors simply never reaches `onFailure`.)
 *
 * Bound: a probe that never settles is abandoned after `timeoutMs` and takes
 * `onFailure` too, so a socket that accepts and then dribbles cannot hold the
 * batch open. The abandoned promise is left to its own transport timeout — it is
 * still attached to the race, so a late rejection is handled, not unhandled.
 *
 * `timeoutMs <= 0` disables the bound (probes are then trusted to settle).
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
