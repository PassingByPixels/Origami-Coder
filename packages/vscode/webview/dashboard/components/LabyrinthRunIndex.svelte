<script lang="ts">
  // The Labyrinth's LEFT panel: the index of past runs, and its states (still
  // loading / genuinely none / filtered to none / the list). Extracted from
  // LabyrinthPane.svelte, which was at its architecture cap when the map
  // toolbar gained its export control; its own head went on to
  // LabyrinthRunSearch.svelte when the filter landed, and the collab member
  // rows to LabyrinthCollabRows.svelte when the price gear did.
  //
  // Presentation only. The pane still owns the requestHistory/historyList wire,
  // the selection and the price table — this component never posts a message of
  // its own, so there is still exactly one session lister on this board.
  // Colours are theme vars ONLY.
  //
  // A COLLAB's members list as unrelated roots, so they collapse under ONE
  // pickable header (mapping the collab whole) that opens to the member rows.
  import LabyrinthRunSearch from './LabyrinthRunSearch.svelte';
  import LabyrinthCollabRows from './LabyrinthCollabRows.svelte';
  import LabyrinthPrices from './LabyrinthPrices.svelte';
  import { collabIndex, whenLabel, type CollabRow } from './labyrinthCollabIndex';
  import { filterIndex, matchCount } from './labyrinthSearch';
  import type { ModelUsage, PriceTable } from './labyrinthCost';
  import { healthLabel, runCacheHealth, type RunStatRow } from './labyrinthHealth';

  let {
    runs, loaded, selected, onRefresh, onSelect, width,
    models = [], prices = {}, pricesOpen = false, onPrices, onSavePrices, stats = {},
  }: {
    runs: CollabRow[];
    loaded: boolean;
    selected: string | null;
    onRefresh: () => void;
    onSelect: (sessionId: string) => void;
    width?: number; // t-q41pe0's divider, in px; undefined = the default 300px below.
    /** The open run's models — the rows the price panel asks about. */
    models?: readonly ModelUsage[];
    prices?: PriceTable;
    pricesOpen?: boolean;
    onPrices?: () => void;
    onSavePrices?: (next: PriceTable) => void;
    /** Per-run counts, keyed by session id. Absent row = no cell, not a 0%. */
    stats?: Record<string, RunStatRow>;
  } = $props();

  let query = $state('');
  let all = $derived(collabIndex(runs));
  let groups = $derived(filterIndex(all, query));
  let open = $state(new Set<string>());
  const toggle = (id: string) => { open = new Set(open.has(id) ? [...open].filter((x) => x !== id) : [...open, id]); };
</script>

<div class="lab-index" style={width ? `width:${width}px` : undefined}>
  <LabyrinthRunSearch shown={matchCount(groups)} total={matchCount(all)} {query} onQuery={(q) => (query = q)} {onRefresh}
    {pricesOpen} {onPrices} />
  {#if pricesOpen && onSavePrices}<LabyrinthPrices {models} {prices} onSave={onSavePrices} onClose={() => onPrices?.()} />{/if}
  {#if !loaded}
    <div class="lab-empty">Loading past runs…</div>
  {:else if runs.length === 0}
    <div class="lab-empty">No past runs yet. Every chat that takes a turn is stored and shows up here.</div>
  {:else if groups.length === 0}
    <!-- A THIRD state, never folded into "no past runs yet": the runs exist,
         the filter is what is hiding them, and only this wording says so. -->
    <div class="lab-empty">No run matches “{query}”.</div>
  {:else}
    <div class="lab-runs">
      {#each groups as g (g.pickId)}
        <button class="lab-run" class:selected={selected === g.pickId} class:is-collab={g.collab} aria-current={selected === g.pickId ? 'true' : undefined} onclick={() => onSelect(g.pickId)}>
          <span class="lab-run-title">{g.title}</span>
          <span class="lab-run-meta">{#if g.subtitle}<span class="lab-agents">{g.subtitle}</span>{/if}{#if g.folder}<span class="lab-folder">{g.folder}</span>{/if}{#if g.updatedAt}<span>{whenLabel(g.updatedAt)}</span>{/if}{#if stats[g.pickId]}<span class="lab-folder lab-health" class:warn={runCacheHealth(stats[g.pickId]).warn} title="Share of prefill served from cache. A dash means this run cannot be read that way — the provider reported no cache tokens, or there were too few requests to mean anything.">cache {healthLabel(runCacheHealth(stats[g.pickId]))}</span>{/if}</span>
        </button>
        {#if g.collab}
          <LabyrinthCollabRows members={g.members} {selected} open={open.has(g.pickId)} onToggle={() => toggle(g.pickId)} {onSelect} />
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .lab-index { width: 300px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid var(--og-border); min-height: 0; }
  .lab-runs { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
  .lab-run { display: flex; flex-direction: column; gap: 3px; text-align: left; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 8px 9px; cursor: pointer; color: var(--og-text); font-family: inherit; }
  .lab-run:hover { border-color: var(--og-chat); }
  .lab-run.selected { border-color: var(--og-accent); background: var(--og-surface-alt); }
  .lab-run-title { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lab-run-meta { display: flex; gap: 6px; align-items: center; font-size: 9px; color: var(--og-text-muted); }
  .lab-folder { background: var(--og-btn-bg); border-radius: 3px; padding: 0 5px; color: var(--og-text-secondary); }
  /* A .lab-folder chip plus the WARNING tone — never tone alone: the number beside the word "cache" says it too. */
  .lab-health { font-variant-numeric: tabular-nums; } .lab-health.warn { color: var(--og-warning); }
  /* A seam down the edge, so a collab header is not read as just another run. */
  .lab-run.is-collab { border-left: 2px solid var(--og-accent-2); }
  .lab-agents { background: var(--og-accent-2); border-radius: 3px; padding: 0 5px; color: var(--og-text); }
  .lab-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; }
</style>
