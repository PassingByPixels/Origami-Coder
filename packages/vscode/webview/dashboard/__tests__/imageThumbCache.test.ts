// imageThumbCache.test.ts — t-ru0by6 follow-up. beginBatch()'s per-call
// eviction skip (the fix for the subagentTranscriptData poll thrash) must not
// be permanent: if a child's drawer closes and no poll ever calls beginBatch()
// again, the cache must not grow forever off unrelated single remember()
// calls (restoreMessages, a live toolResult). This proves the expiry: no
// beginBatch() within BATCH_EXPIRE_MS of the last one, and the very next
// remember() drops back to plain per-call LRU, capped at `limit` again.

import { describe, expect, it, vi } from 'vitest';
import { makeThumbCache } from '../../../src/dashboard/imageThumbCache';

describe('imageThumbCache — batch mode expires without a fresh beginBatch()', () => {
  it('reverts to per-call eviction (<= limit) once the batch window has passed', () => {
    vi.useFakeTimers();
    try {
      const cache = makeThumbCache(20);
      cache.beginBatch();

      // Past the window: 3 missed polls at the 4s cadence (POLL_MS,
      // SubagentTranscriptView.svelte) = 12s, plus one millisecond.
      vi.advanceTimersByTime(12_001);

      for (let i = 0; i < 25; i++) cache.remember(`k${i}`, `v${i}`);

      let size = 0;
      for (let i = 0; i < 25; i++) if (cache.get(`k${i}`) !== undefined) size++;
      expect(size).toBeLessThanOrEqual(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays in batch mode (no eviction) inside the window', () => {
    vi.useFakeTimers();
    try {
      const cache = makeThumbCache(20);
      cache.beginBatch();

      vi.advanceTimersByTime(11_000); // still inside the 12s window

      for (let i = 0; i < 25; i++) cache.remember(`k${i}`, `v${i}`);

      let size = 0;
      for (let i = 0; i < 25; i++) if (cache.get(`k${i}`) !== undefined) size++;
      expect(size).toBe(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fresh beginBatch() inside the window resets the expiry clock', () => {
    vi.useFakeTimers();
    try {
      const cache = makeThumbCache(20);
      cache.beginBatch();
      vi.advanceTimersByTime(11_000);
      cache.beginBatch(); // renews the window
      vi.advanceTimersByTime(11_000); // 22s since the FIRST beginBatch, but only 11s since the renewal

      for (let i = 0; i < 25; i++) cache.remember(`k${i}`, `v${i}`);

      let size = 0;
      for (let i = 0; i < 25; i++) if (cache.get(`k${i}`) !== undefined) size++;
      expect(size).toBe(25);
    } finally {
      vi.useRealTimers();
    }
  });
});
