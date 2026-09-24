<script lang="ts">
  // The Labyrinth's LEFT panel: the index of past runs, and its states (still
  // loading / genuinely none / filtered to none / the list). Extracted from
  // LabyrinthPane.svelte, which was at its architecture cap when the map
  // toolbar gained its export control; its own head went on to
  // LabyrinthRunSearch.svelte when the filter landed, and the collab member
  // rows to LabyrinthCollabRows.svelte when the price gear did, and the CARD
  // itself to LabyrinthRunCard.svelte when the delete control did.
  //
  // Presentation only. The pane still owns the requestHistory/historyList wire,
  // the selection and the price table — this component never posts a message of
  // its own, so there is still exactly one session lister on this board.
  // Colours are theme vars ONLY.
  //
  // A COLLAB's members list as unrelated roots, so they collapse under ONE
  // pickable header (mapping the collab whole) that opens to the member rows.
  import LabyrinthRunSearch from './LabyrinthRunSearch.svelte';
  import LabyrinthRunCard from './LabyrinthRunCard.svelte';
  import LabyrinthCollabRows from './LabyrinthCollabRows.svelte';
  import LabyrinthPrices from './LabyrinthPrices.svelte';
  import { collabIndex, type CollabRow } from './labyrinthCollabIndex';
  import { filterIndex, matchCount } from './labyrinthSearch';
  import type { ModelUsage, PriceTable } from './labyrinthCost';
  import type { RunStatRow } from './labyrinthHealth';
  import { CLAUDE_MARK } from '../../chat/historyKinds';

  let {
    runs, loaded, selected, onRefresh, onSelect, onDelete, deleteError = null, width,
    models = [], prices = {}, pricesOpen = false, onPrices, onSavePrices, stats = {}, showClaude = true, onShowClaude,
  }: {
    runs: CollabRow[];
    loaded: boolean;
    selected: string | null;
    onRefresh: () => void;
    onSelect: (sessionId: string) => void;
    /** Absent = no delete control on any card (a surface that did not wire it). */
    onDelete?: (sessionId: string) => void;
    /** Why the LAST delete did not happen. Shown at the head of the list, not on
     *  the card: the card that asked has already closed its confirm, and the
     *  commonest refusal ("close the chat first") is about a different window. */
    deleteError?: string | null;
    width?: number; // t-q41pe0's divider, in px; undefined = the default 300px below.
    /** The open run's models — the rows the price panel asks about. */
    models?: readonly ModelUsage[];
    prices?: PriceTable;
    pricesOpen?: boolean;
    onPrices?: () => void;
    onSavePrices?: (next: PriceTable) => void;
    /** Per-run counts, keyed by session id. Absent row = no cell, not a 0%. */
    stats?: Record<string, RunStatRow>;
    showClaude?: boolean; onShowClaude?: (on: boolean) => void; // the History popup's switch, on the SAME stored preference (historyKinds.ts)
  } = $props();

  let query = $state('');
  let all = $derived(collabIndex(runs));
  let groups = $derived(filterIndex(all, query));
  let open = $state(new Set<string>());
  const toggle = (id: string) => { open = new Set(open.has(id) ? [...open].filter((x) => x !== id) : [...open, id]); };
</script>

<div class="lab-index" style={width ? `width:${width}px` : undefined}>
  <LabyrinthRunSearch shown={matchCount(groups)} total={matchCount(all)} {query} onQuery={(q) => (query = q)} {onRefresh}
    {pricesOpen} {onPrices} claudeMark={CLAUDE_MARK} {showClaude} {onShowClaude} />
  {#if pricesOpen && onSavePrices}<LabyrinthPrices {models} {prices} onSave={onSavePrices} onClose={() => onPrices?.()} />{/if}
  {#if deleteError}<div class="lab-del-error">{deleteError}</div>{/if}
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
        <LabyrinthRunCard title={g.title} subtitle={g.subtitle} folder={g.folder} updatedAt={g.updatedAt} collab={g.collab} selected={selected === g.pickId} stat={stats[g.pickId]} mark={g.kind === 'claude' ? CLAUDE_MARK : ''} markTitle="Claude Code chat — mapped from its own transcript, not an engine run" onSelect={() => onSelect(g.pickId)} onDelete={onDelete && g.kind !== 'claude' ? () => onDelete(g.pickId) : undefined} />
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
  /* The card's own rules moved with it to LabyrinthRunCard.svelte — Svelte
     scopes <style> per component, so they belong where the markup is drawn. */
  .lab-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; }
  .lab-del-error { color: var(--og-error); font-size: 11px; line-height: 1.5; padding: 6px 10px; }
</style>
