// The pure cache-hit-ratio arithmetic behind CacheStatsCard — split out so
// the formula is testable with no DOM (mirrors pinnedUser.ts / modelLabel.ts).
//
// The ratio is READ tokens as a share of every token this turn's cache
// touched: fresh input (never cached), cache READ (served from cache) and
// cache WRITE (freshly cached for a future turn). WRITE belongs in the
// denominator, not in a "misses" bucket — writing to the cache is not a
// failed lookup, it is the turn that MAKES the next read possible. A
// write-heavy, read-empty session is a cold cache warming up, not a broken
// one; do not word the label as hit-vs-miss.
export interface CacheTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/** read / (input + cacheRead + cacheWrite). Zero when nothing moved at all —
 *  a provider that never reports cache fields (most local servers) shows
 *  every number here as zero, honestly, rather than an undefined ratio. */
export function cacheReadRatio(t: CacheTokens): number {
  const total = t.input + t.cacheRead + t.cacheWrite;
  return total > 0 ? t.cacheRead / total : 0;
}
