<script lang="ts">
  // The composer's dropdown, EXTRACTED VERBATIM from InputBar.svelte (948 of
  // its 955-line cap) so the flock M4 `@` participant picker could land without
  // raising it — the ratchet's own remedy.
  //
  // It is deliberately GENERIC over `{name, description, category}` rather than
  // over SlashCommand: the `/` palette and the `@` picker are the same object
  // on screen (filter as you type, arrow/Tab/Enter, click to insert), and two
  // copies of that markup would be two places for the two to drift apart. The
  // caller owns the filtering and the selection index; this owns the drawing.
  interface Row {
    /** The monospaced handle — `/archive`, `@collab-crane`. Also the key. */
    name: string;
    description: string;
    category: string;
  }

  interface Props {
    items: Row[];
    selectedIdx: number;
    onPick: (i: number) => void;
    onHover: (i: number) => void;
    /** What an empty filter result SAYS. A blank dropdown reads as broken. */
    emptyText: string;
  }
  let { items, selectedIdx, onPick, onHover, emptyText }: Props = $props();
</script>

<div class="slash-dropdown">
  {#each items as item, i (item.name)}
    <button class="slash-item" class:selected={i === selectedIdx} onclick={() => onPick(i)} onpointerenter={() => onHover(i)}>
      <span class="slash-name">{item.name}</span>
      <span class="slash-desc">{item.description}</span>
      <span class="slash-cat">{item.category}</span>
    </button>
  {/each}
  {#if items.length === 0}<div class="slash-empty">{emptyText}</div>{/if}
</div>

<style>
  /* Carried across from InputBar.svelte with the markup — Svelte scopes styles
     per component, so the rules the rows need live here now. */
  .slash-dropdown { position: absolute; bottom: 100%; left: 12px; right: 100px; max-height: 280px; overflow-y: auto; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; box-shadow: 0 -4px 16px rgba(0,0,0,0.3); padding: 4px; z-index: 50; }
  .slash-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px; background: none; border: none; color: var(--og-text); font-family: inherit; font-size: 12px; cursor: pointer; border-radius: 4px; text-align: left; }
  .slash-item:hover, .slash-item.selected { background: var(--og-btn-bg); }
  .slash-name { font-weight: 600; color: var(--og-chat); min-width: 110px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .slash-desc { flex: 1; color: var(--og-text-secondary); font-size: 11px; }
  .slash-cat { font-size: 10px; color: var(--og-text-muted); padding: 1px 6px; background: var(--og-surface-alt, var(--og-bg)); border-radius: 3px; }
  .slash-empty { padding: 8px; color: var(--og-text-muted); font-size: 11px; font-style: italic; text-align: center; }
</style>
