// imageThumbCache.ts — the LRU both host-side picture paths share.
//
// LIFTED out of readImageThumb.ts (t-fisfs5 R6) so desktopImageFallback.ts uses
// the SAME cache shape rather than a second one that drifts. One card can
// restamp the same file several times — a live update, then the
// `restoreMessages` replay on every reopen, once per attached view — and a
// decode is tens of milliseconds of synchronous work on the extension host.
//
// The key is the caller's business; both callers use `path + ':' + mtimeMs`, so
// the file changing invalidates the entry on its own.

/** A bounded most-recently-used map of strings. `''` is a real, remembered
 *  value meaning "tried and failed", and `remember` returns it as `undefined`
 *  so a caller can hand its answer straight back. */
export interface ThumbCache {
  /** The stored value, or `undefined` when this key has never been tried.
   *  `''` is a hit, not a miss. */
  get(key: string): string | undefined;
  remember(key: string, value: string): string | undefined;
  /**
   * t-ru0by6: marks the start of a new batch of `remember()` calls that must
   * not evict EACH OTHER. A caller that walks a whole list synchronously (a
   * `subagentTranscriptData` poll with more out-of-root images than `limit`)
   * used to thrash: entry 21 evicted entry 1's still-fresh answer from the
   * SAME walk, so the very next poll re-read everything, every time.
   *
   * Once a caller calls this at least once, `remember()` stops evicting
   * per-call for THIS cache — an over-sized batch just grows it — and pruning
   * instead happens HERE, at the next batch's start, removing only entries
   * that are two or more batches stale. That keeps the immediately preceding
   * batch fully intact through the whole of the next one, so an unchanged
   * poll is a full hit, while a batch nobody re-touches for two more polls
   * still ages out. A caller that never calls this keeps the original
   * per-call, oldest-first eviction, unchanged.
   *
   * NOT permanent: if no `beginBatch()` arrives within `BATCH_EXPIRE_MS` of
   * the last one — the drawer closed, polling stopped — the next
   * `remember()` reverts to plain per-call eviction, so an unrelated single
   * remember() (`restoreMessages`, a live `toolResult`) cannot grow this
   * cache forever off a batch nobody is renewing any more.
   */
  beginBatch(): void;
}

/** Three missed polls at the drawer's own cadence (`POLL_MS`,
 *  `webview/dashboard/components/SubagentTranscriptView.svelte`) — mirrored
 *  as a literal here rather than imported: this file is host-side
 *  (`src/dashboard/`) and that one is webview code, across the
 *  `tsconfig.webview.json` `rootDir` boundary (see
 *  `docs/WORKING_ON_ORIGAMI_CODER.md` Part 5). If `POLL_MS` there changes,
 *  update this too. */
const SUBAGENT_POLL_MS = 4_000;
const BATCH_EXPIRE_MS = SUBAGENT_POLL_MS * 3;

export function makeThumbCache(limit: number): ThumbCache {
  const entries = new Map<string, { value: string; gen: number }>();
  let gen = 0;
  let batching = false;
  let lastBatchAt = 0;
  return {
    get: (key) => entries.get(key)?.value,
    remember(key, value) {
      if (batching && Date.now() - lastBatchAt > BATCH_EXPIRE_MS) batching = false;
      entries.delete(key);
      entries.set(key, { value, gen });
      if (!batching && entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return value || undefined;
    },
    beginBatch() {
      batching = true;
      lastBatchAt = Date.now();
      gen++;
      for (const [k, v] of entries) {
        if (v.gen <= gen - 2) entries.delete(k);
      }
    },
  };
}
