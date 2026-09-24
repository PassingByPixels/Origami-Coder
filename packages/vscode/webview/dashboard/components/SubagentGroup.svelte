<script lang="ts">
  // SubagentGroup.svelte — ONE labelled band of the sub-agent drawer: its
  // heading, its count, and the rows under it.
  //
  // EXTRACTED from SubagentDrawer.svelte (183/185) when the roster split into
  // Running and Complete. The drawer owns the panel, the slide and the whole-
  // list fold; a BAND inside it owns its own heading and list, so adding a
  // group is one more tag there rather than a second copy of an {#each} and
  // its <ul> styling.
  //
  // AN EMPTY GROUP DRAWS NOTHING — not even its heading. A chat with three
  // live agents and none finished must not carry a standing "Complete 0": the
  // drawer is a 240px glance surface, and a heading over no rows spends a line
  // of it saying nothing.
  import type { SubagentGroupProps } from '../panes/subagentProps';
  import SubagentRow from './SubagentRow.svelte';

  // The prop SHAPE lives in subagentProps.ts — see that file's header.
  let { label, rows, collapsed = false, onToggleCollapse, limitMs = 0, onOpen, onDismiss, onStop }: SubagentGroupProps = $props();
</script>

{#if rows.length > 0}
  <div class="sa-group">
    {#if onToggleCollapse}
      <button class="sa-group-head sa-group-fold" aria-expanded={!collapsed} onclick={onToggleCollapse}>
        <span class="sa-group-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <span class="sa-group-label">{label}</span>
        <span class="sa-group-count">{rows.length}</span>
      </button>
    {:else}
      <div class="sa-group-head">
        <span class="sa-group-label">{label}</span>
        <span class="sa-group-count">{rows.length}</span>
      </div>
    {/if}
    {#if !collapsed}
      <ul class="sa-list">
        {#each rows as row (row.key)}
          <SubagentRow {row} {onDismiss} {onOpen} {onStop} {limitMs} />
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .sa-group { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  /* Quieter than the drawer's own .sa-head — this is a divider inside a panel
     that already named itself, not a second title competing with it. */
  .sa-group-head { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
  /* A foldable heading is a real <button> stripped back to the <div> look. */
  .sa-group-fold { width: 100%; background: transparent; border: none; padding: 0; cursor: pointer; font-family: inherit; text-align: left; }
  .sa-group-chevron { flex: 0 0 auto; font-size: 8px; color: var(--og-text-muted); }
  .sa-group-label {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--og-text-muted);
  }
  .sa-group-count { font-size: 9px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }

  .sa-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }
</style>
