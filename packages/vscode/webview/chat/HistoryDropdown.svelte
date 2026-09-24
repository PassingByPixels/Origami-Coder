<script lang="ts">
  // The sidebar's HISTORY popup, extracted VERBATIM from SidebarLauncher.svelte
  // so the Collabs half can draw its archived rooms with the same object rather
  // than a second, thinner list of its own. Two surfaces asking "which past one
  // do you want?" should not be two different controls.
  //
  // GENERIC over {id, title, meta} for the reason SlashDropdown.svelte is
  // generic over {name, description, category}: the caller owns its own wire
  // shape and its own FILTER — a chat matches on title+folder, an archived
  // collab on title alone — and this owns the drawing. Two copies of the markup
  // would be two places for the two lists to drift apart.
  //
  // `loading` and `emptyText` are separate on purpose: "still asking the host"
  // and "asked, and there is nothing" are different facts, and folding them
  // into one blank panel is the exact class of silence this list exists to
  // avoid. A collab list is already resident, so it passes loading={false} and
  // makes no round trip at all.
  import { untrack } from 'svelte';
  import HistoryKindToggle from './HistoryKindToggle.svelte';
  import { computeHistoryPlacement, type HistoryPlacement } from './historyAnchor';

  interface Row {
    /** Stable key, and what `onPick` hands back. */
    id: string;
    title: string;
    /** The dim second line — folder · date, or a state tag. Omitted = no line. */
    meta?: string;
    /** Row tooltip. Falls back to the id, which is what the chats half showed. */
    tooltip?: string;
    /** A short badge before the title — the chats half marks Claude Code rows
     *  with `CC` (historyKinds.ts). Absent on rows that need no mark, so an
     *  unmarked list still aligns; this panel never decides WHICH rows get one. */
    mark?: string;
    markTitle?: string;
  }

  interface Props {
    items: Row[];
    /** True only while a host round trip is outstanding. */
    loading: boolean;
    query: string;
    onQuery: (value: string) => void;
    onPick: (id: string) => void;
    onClose: () => void;
    /** What an empty list SAYS. A blank dropdown reads as broken. */
    emptyText: string;
    /** A dim footer under the list — what was scanned (claudeScanNote.ts). */
    note?: string;
    /** Optional show/hide switch for the marked rows. Absent = no switch, which
     *  is the Collabs half: it has one kind of row and nothing to filter. */
    kindToggle?: { on: boolean; mark: string; onChange: (next: boolean) => void };
    anchorEl?: HTMLElement; // toolbar rect -> fixed overlay (t-hb1o0e); absent = old in-flow (Collabs half)
  }
  let { items, loading, query, onQuery, onPick, onClose, emptyText, note, kindToggle, anchorEl }: Props = $props();

  /** Carried across with the markup: the search box takes focus on open, so
   *  the control is usable from the keystroke that opened it. */
  function focusOnMount(node: HTMLInputElement) { node.focus(); }

  // Computed once at mount, only when a toolbar rect was given.
  const placement: HistoryPlacement | null = untrack(() =>
    anchorEl ? computeHistoryPlacement(anchorEl.getBoundingClientRect(), window.innerHeight) : null);
</script>

<!-- Backdrop only when overlaying: outside clicks land on it, a click on the panel doesn't (idiom shared with AgentModelSelect's .ams-backdrop). -->
{#if placement}<button class="history-backdrop" aria-label="Close history" onclick={onClose}></button>{/if}
<div class="history-dropdown" class:hd-overlay={!!placement} role="dialog" aria-label="History"
  style={placement ? `top: ${placement.top}px; left: ${placement.left}px; width: ${placement.width}px; max-height: ${placement.maxHeight}px` : undefined}>
  <input
    class="history-search"
    type="text"
    placeholder="Search…"
    value={query}
    oninput={(e) => onQuery((e.currentTarget as HTMLInputElement).value)}
    use:focusOnMount
    onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}
  />
  {#if kindToggle}
    <HistoryKindToggle on={kindToggle.on} mark={kindToggle.mark} onChange={kindToggle.onChange} />
  {/if}
  <div class="history-list">
    {#if loading}
      <div class="history-empty">Loading…</div>
    {:else if items.length === 0}
      <div class="history-empty">{emptyText}</div>
    {:else}
      {#each items as h (h.id)}
        <button class="history-row" onclick={() => onPick(h.id)} title={h.tooltip ?? h.id}>
          <span class="history-line">
            {#if h.mark}<span class="history-mark" title={h.markTitle}>{h.mark}</span>{/if}
            <span class="history-title">{h.title}</span>
          </span>
          {#if h.meta}<span class="history-meta">{h.meta}</span>{/if}
        </button>
      {/each}
    {/if}
  </div>
  {#if note && !loading}<div class="history-empty" data-testid="history-note">{note}</div>{/if}
</div>

<style>
  .history-backdrop { position: fixed; inset: 0; z-index: 5; background: transparent; border: none; padding: 0; margin: 0; cursor: default; }
  .history-dropdown {
    display: flex; flex-direction: column; overflow: hidden; margin: 0 10px 6px; max-height: 260px;
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 8px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  }
  .history-dropdown.hd-overlay { position: fixed; z-index: 6; margin: 0; max-height: none; }
  .history-search {
    margin: 8px;
    padding: 6px 8px;
    font-size: 12px;
    font-family: inherit;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    outline: none;
  }
  .history-search:focus { border-color: var(--og-accent); }
  .history-list {
    flex: 1 1 auto; overflow-y: auto; padding: 0 6px 6px;
    display: flex; flex-direction: column; gap: 2px;
  }
  .history-row {
    display: flex;
    flex-direction: column;
    gap: 1px;
    text-align: left;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .history-row:hover { background: var(--og-btn-bg); }
  .history-line { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
  /* Dashed, like the Claude Code square in the connections row — a harness the
     user owns, not a connection this extension configured. */
  .history-mark { flex-shrink: 0; font-size: 9px; font-weight: 600; letter-spacing: 0.04em; padding: 0 3px; color: var(--og-text-secondary); border: 1px dashed var(--og-border); border-radius: 3px; }
  .history-title {
    font-size: 12px;
    color: var(--og-text);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .history-meta {
    font-size: 10px;
    color: var(--og-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .history-empty {
    padding: 12px 10px;
    font-size: 11px;
    font-style: italic;
    color: var(--og-text-muted);
    text-align: center;
  }
</style>
