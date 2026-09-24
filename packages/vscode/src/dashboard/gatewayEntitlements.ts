// Which of a keyless-catalog gateway's models can THIS key actually call? The gateway's GET /models
// is a menu, not an entitlement list — the same catalog returns with or without a key while the
// tier is enforced per-request. This probes each id with a one-token chat-completion, the same
// route the engine itself uses.
//
// Verdicts: 2xx or 429 = entitled (429 means the auth gate let it through and only the rate limiter
// objected); 401/403 = not entitled; other 4xx/5xx = not served right now; a thrown fetch is
// excluded quietly so one dead probe cannot cost its neighbours.
//
// Every probe carries `x-opencode-session`. The Go base REQUIRES it: without the header each id
// answers `400 MissingSessionID` ("cannot be routed efficiently"), the whole sweep comes back
// empty, and mergeLiveModels then keeps the CONFIGURED list — so the Go tab silently showed the
// handful of ids origami.json happened to hold instead of the gateway's real catalog (t-ry6ecn,
// verified 2026-09-22: the same POST returns 200 with the header). The Zen base ignores it.
//
// Pure and vscode-free: fetch is injected, and the caller owns caching/pacing — concurrency is
// bounded here so a full sweep is a trickle, not a request storm.

/** Probe every catalog id and return the ones this key can call, in catalog
 *  order. `sessionId` is sent as `x-opencode-session` (the Go base rejects a
 *  probe without one); `concurrency` bounds in-flight probes; each probe times
 *  out alone. */
export async function sweepEntitledModels(
  baseURL: string,
  apiKey: string,
  ids: readonly string[],
  fetchImpl: typeof fetch,
  sessionId: string,
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
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'x-opencode-session': sessionId,
          },
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
