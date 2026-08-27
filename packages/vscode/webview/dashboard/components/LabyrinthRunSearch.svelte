<script lang="ts">
  // The run index's head: what the panel is, how many rows it OFFERS, the
  // filter box and the reload. Extracted from LabyrinthRunIndex.svelte, which
  // was at its architecture cap when the filter landed.
  //
  // Presentation only — the parent owns the query and does the filtering, so
  // there is still exactly one place that knows what a match is.
  // The count reads "shown/total" only while a filter is narrowing anything;
  // printing "12/12" unfiltered would imply a filter that is not there.
  // Colours are theme vars ONLY.
  let {
    shown, total, query, onQuery, onRefresh, pricesOpen = false, onPrices,
  }: {
    shown: number;
    total: number;
    query: string;
    onQuery: (q: string) => void;
    onRefresh: () => void;
    /** Whether the price panel is showing; the gear reports it, never colour alone. */
    pricesOpen?: boolean;
    onPrices?: () => void;
  } = $props();
</script>

<div class="lab-index-top">
  <div class="lab-index-head">
    <span class="lab-index-title">Run index</span>
    <span class="lab-count" title={shown === total ? 'Runs and member runs listed' : 'Rows matching the filter, of all rows'}>{shown === total ? total : `${shown}/${total}`}</span>
    {#if onPrices}
      <button class="lab-refresh lab-prices" class:on={pricesOpen} aria-pressed={pricesOpen} onclick={onPrices}
        title="Your own $/Mtok prices, for an indicative cost">⚙</button>
    {/if}
    <button class="lab-refresh" onclick={onRefresh} title="Reload past runs">↻</button>
  </div>
  <input class="lab-search" type="search" placeholder="Filter runs…" aria-label="Filter the run index"
    value={query} oninput={(e) => onQuery((e.currentTarget as HTMLInputElement).value)} />
</div>

<style>
  .lab-index-top { border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  .lab-index-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px 6px; }
  .lab-index-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-secondary); flex: 1; }
  .lab-count { font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .lab-refresh { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 8px; font-size: 13px; }
  .lab-refresh:hover { background: var(--og-btn-hover); }
  /* OPEN is carried by the border AND aria-pressed, never by the fill alone. */
  .lab-prices.on { border-color: var(--og-accent); color: var(--og-accent); }
  .lab-search { display: block; width: calc(100% - 24px); margin: 0 12px 8px; box-sizing: border-box; background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 4px; padding: 3px 6px; font-size: 11px; font-family: inherit; }
  .lab-search:focus { outline: 1px solid var(--og-accent); }
</style>
