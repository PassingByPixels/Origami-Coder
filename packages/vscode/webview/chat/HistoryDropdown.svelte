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
  interface Row {
    /** Stable key, and what `onPick` hands back. */
    id: string;
    title: string;
    /** The dim second line — folder · date, or a state tag. Omitted = no line. */
    meta?: string;
    /** Row tooltip. Falls back to the id, which is what the chats half showed. */
    tooltip?: string;
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
  }
  let { items, loading, query, onQuery, onPick, onClose, emptyText }: Props = $props();

  /** Carried across with the markup: the search box takes focus on open, so
   *  the control is usable from the keystroke that opened it. */
  function focusOnMount(node: HTMLInputElement) { node.focus(); }
</script>

<div class="history-dropdown" role="dialog" aria-label="History">
  <input
    class="history-search"
    type="text"
    placeholder="Search…"
    value={query}
    oninput={(e) => onQuery((e.currentTarget as HTMLInputElement).value)}
    use:focusOnMount
    onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}
  />
  <div class="history-list">
    {#if loading}
      <div class="history-empty">Loading…</div>
    {:else if items.length === 0}
      <div class="history-empty">{emptyText}</div>
    {:else}
      {#each items as h (h.id)}
        <button class="history-row" onclick={() => onPick(h.id)} title={h.tooltip ?? h.id}>
          <span class="history-title">{h.title}</span>
          {#if h.meta}<span class="history-meta">{h.meta}</span>{/if}
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  /* Carried across from SidebarLauncher.svelte with the markup — Svelte scopes
     styles per component, so the rules the rows need live here now. */
  .history-dropdown {
    margin: 0 10px 6px;
    max-height: 260px;
    display: flex;
    flex-direction: column;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 8px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
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
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 0 6px 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
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
  .history-title {
    font-size: 12px;
    color: var(--og-text);
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
