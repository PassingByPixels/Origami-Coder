// gatewayEntitlements.ts — which of a keyless-catalog gateway's models can THIS
// key actually call?
//
// Zen/Go's GET /models is a MENU, not an entitlement list: it answers the same
// 64 ids with or without a key (verified live 2026-08-21), while the tier is
// enforced per-request — a Go key gets 401 on 55 of them. Feeding the raw
// catalog to the model picker therefore offers a menu where most first turns
// die. This leaf asks the only oracle the gateway exposes: a one-token
// chat-completion per id, the exact route and shape the engine itself uses, so
// "entitled" means "turn one will reach a model".
//
// Verdicts, from the live sweep the shape was derived from:
//   · 2xx           → entitled (costs one token — the same price the connect
//                     flow's key probe already pays).
//   · 429           → entitled: the auth gate said nothing against the key,
//                     the gateway said "slow down". Excluding it would drop a
//                     usable model for a whole cache window because the sweep
//                     itself was what tripped the limiter.
//   · 401 / 403     → NOT entitled — the key's tier does not cover the model.
//   · other 4xx/5xx → NOT served right now (deepseek-v4-flash-free answered
//                     500 on a valid key while listed in the catalog). Same
//                     doctrine as the LM Studio live mirror: the row drops
//                     while broken and returns when the server does.
//   · thrown fetch  → excluded quietly; one dead probe must not invent an
//                     entitlement, and its neighbours are unaffected.
//
// Pure and vscode-free: fetch is injected, nothing here touches config or the
// network on its own. The caller owns caching and pacing — this function's own
// restraint is the concurrency bound, so a 64-id sweep is a brief trickle
// rather than a request storm.

/** Probe every catalog id and return the ones this key can call, in catalog
 *  order. `concurrency` bounds in-flight probes; each probe times out alone. */
export async function sweepEntitledModels(
  baseURL: string,
  apiKey: string,
  ids: readonly string[],
  fetchImpl: typeof fetch,
  concurrency = 6,
): Promise<string[]> {
  const base = baseURL.replace(/\/+$/, '');
  const entitled = new Array<boolean>(ids.length).fill(false);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < ids.length) {
      const i = next++;
      try {
        const res = await fetchImpl(`${base}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: ids[i],
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(10000),
        });
        entitled[i] = res.ok || res.status === 429;
      } catch {
        /* excluded — see header */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, lane));
  return ids.filter((_, i) => entitled[i]);
}
