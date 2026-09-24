// t-rylyhm — cacheWarmState.ts: what the composer's cache badge shows, given
// the last `origami/cacheState` the engine pushed.
//
// A TABLE, not a rendering, and extracted for the reason visionButtonState.ts
// was: the rules are the part worth checking, and a table can be checked
// without a DOM. CacheWarmDot.svelte draws the answer and decides nothing.
//
// THE ONE RULE WORTH STATING IN PROSE. Nothing here derives a state. The engine
// is the only place that sees the cache-read token count a provider returns, so
// the badge reports what it was told and nothing else — it never infers "warm"
// from a warmer being armed, from a turn having just run, or from a clock. That
// is also why there is NO TIMER here: a badge that counted down by itself would
// keep counting after the prefix was thrown away by a compaction it never saw.
// The engine pushes its own expiry, and that push is what turns this cold.

export type CacheWarm = 'warm' | 'cold' | 'unmeasured';

export interface CacheWarmView {
  readonly state: CacheWarm;
  /** Three distinct glyphs: filled, hollow, and a dash for "no reading". */
  readonly icon: string;
  readonly label: string;
  readonly title: string;
}

/** The last push, as the host forwards it. `until`/`ttlSeconds` are absent when
 *  the provider publishes no window — absent, never zero. */
export interface CacheWarmInput {
  readonly state: string;
  readonly until?: number;
  readonly ttlSeconds?: number;
  /** Injected so the remaining-minutes sentence is testable. */
  readonly now?: number;
}

/** Whole minutes, rounded, floored at zero: a negative "left" would mean the
 *  engine's expiry push is in flight, and the honest word for that is "0". */
function minutes(ms: number): number {
  return Math.max(0, Math.round(ms / 60_000));
}

export function cacheWarmView(input: CacheWarmInput): CacheWarmView {
  if (input.state === 'warm') {
    const window_ =
      input.ttlSeconds === undefined || input.until === undefined
        ? // NO COUNTDOWN INVENTED. The provider published no lifetime, so the
          // badge says that instead of guessing one.
          'This provider publishes no cache window, so there is no countdown to show.'
        : `This provider's window is ${minutes(input.ttlSeconds * 1000)} min; about ` +
          `${minutes(input.until - (input.now ?? Date.now()))} min left unless the next request refreshes it.`;
    return {
      state: 'warm',
      icon: '●',
      label: 'Cache',
      title: `Cache warm — the last request read this chat's prefix from the provider's cache. ${window_}`,
    };
  }

  if (input.state === 'cold')
    return {
      state: 'cold',
      icon: '○',
      label: 'Cache',
      title:
        "Cache cold — the last request read nothing from the provider's cache, " +
        'so the next one pays for the whole prompt again.',
    };

  // Anything else, including a state this build does not know: unmeasured.
  // "The provider says nothing" is a different fact from "the prefix is gone",
  // and calling it cold would be a claim nobody made.
  return {
    state: 'unmeasured',
    icon: '–',
    label: 'Cache',
    title:
      'Cache unmeasured — this provider reports no cache tokens at all, ' +
      'so nothing is known about this chat’s prefix.',
  };
}
