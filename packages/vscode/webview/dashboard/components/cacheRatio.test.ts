// cacheReadRatio — the formula behind the Insights cache-hit-ratio card
// (t-kgtw47). The bug worth catching: write tokens dropped from the
// denominator, which would inflate the displayed ratio on any turn that both
// read AND wrote to the cache.
import { describe, expect, it } from 'vitest';
import { cacheReadRatio } from './cacheRatio';

describe('cacheReadRatio', () => {
  it('is read / (input + read + write)', () => {
    expect(cacheReadRatio({ input: 30, cacheRead: 50, cacheWrite: 20 })).toBeCloseTo(0.5);
  });

  it('counts write tokens toward the total moved, so a read+write turn is not overstated as mostly-cached', () => {
    // If write were dropped from the denominator (treated as a "miss" folded
    // into input, or simply omitted), 100 read against 0 input would read as
    // a perfect 100% hit rate. It is really half: 100 of 200 tokens moved.
    expect(cacheReadRatio({ input: 0, cacheRead: 100, cacheWrite: 100 })).toBeCloseTo(0.5);
  });

  it('a write-only turn (cold cache, nothing read yet) is 0, not an inflated ratio', () => {
    expect(cacheReadRatio({ input: 0, cacheRead: 0, cacheWrite: 500 })).toBe(0);
  });

  it('a read-only turn (fully served from cache) is 1', () => {
    expect(cacheReadRatio({ input: 0, cacheRead: 400, cacheWrite: 0 })).toBe(1);
  });

  it('a provider that reports no cache fields at all (every value 0) is 0, not NaN or Infinity', () => {
    expect(cacheReadRatio({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
  });

  it('an all-fresh session (no caching in play) is 0', () => {
    expect(cacheReadRatio({ input: 1000, cacheRead: 0, cacheWrite: 0 })).toBe(0);
  });
});
