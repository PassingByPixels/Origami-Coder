// oauthIdsRead.ts — a bound on the one engine call broadcastProviderStatus makes before it probes
// anything.
//
// An unbounded provider_auth_list call once held the whole broadcast open when the engine never
// answered it, latching providerProbeInFlight forever and killing the context gauge and plan-usage
// pill for every chat.
//
// THE RULE: the auth store gets the same ceiling one provider probe gets. A bound that fires
// answers `undefined` (could not ask — the neutral verdict the probe already handles), never an
// empty set, which would read as "asked; nobody signed in" and cache a false verdict.

/**
 * Ask for the OAuth-connected provider ids, but never wait longer than `timeoutMs`. undefined = the
 *  store could not be asked. Degrades, never throws.
 */
export async function readOauthIds(
  ask: () => Promise<Set<string> | undefined>,
  timeoutMs: number,
): Promise<Set<string> | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs <= 0) return await ask();
    return await Promise.race([
      ask(),
      // Resolves rather than rejects: an unanswered store is a NON-answer, not
      // an error, and the caller already has a branch for exactly that.
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
