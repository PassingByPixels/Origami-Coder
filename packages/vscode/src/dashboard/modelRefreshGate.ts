/**
 * How often opening the model picker is allowed to poke the engine. Each open asks every live
 *  engine to re-read its provider config, so without a gate, flicking the picker open repeatedly
 *  puts the account credential on the wire repeatedly.
 * A gate here as well as the engine's own ten-minute discovery cache, since this also stops the
 *  ext-method round trip and provider-list rebuild on every open. First call always passes — the
 *  picker's whole point is showing the list on first open.
 */
export const MODEL_REFRESH_DEBOUNCE_MS = 10_000;

export interface ModelRefreshGate {
  /** True at most once per window. Records the pass as it answers, so two
   *  callers in the same tick cannot both be told yes. */
  shouldRefresh(): boolean;
}

export function createModelRefreshGate(
  options: { debounceMs?: number; now?: () => number } = {},
): ModelRefreshGate {
  const debounceMs = options.debounceMs ?? MODEL_REFRESH_DEBOUNCE_MS;
  const now = options.now ?? Date.now;
  let last: number | undefined;
  return {
    shouldRefresh(): boolean {
      const at = now();
      // `last === undefined` and not a sentinel number: a clock that answers 0
      // (a fake one in a test, or a host whose Date.now is stubbed) must not
      // read as "already refreshed".
      if (last !== undefined && at - last < debounceMs) return false;
      last = at;
      return true;
    },
  };
}
