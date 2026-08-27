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
  import type { SubagentRow as SubagentRowT } from '../panes/subagentRows';
  import SubagentRow from './SubagentRow.svelte';

  interface Props {
    /** 'Running' / 'Complete'. */
    label: string;
    rows: SubagentRowT[];
    onDismiss: (key: string) => void;
    onOpen: (row: SubagentRowT) => void;
  }
  let { label, rows, onDismiss, onOpen }: Props = $props();
</script>

{#if rows.length > 0}
  <div class="sa-group">
    <div class="sa-group-head">
      <span class="sa-group-label">{label}</span>
      <span class="sa-group-count">{rows.length}</span>
    </div>
    <ul class="sa-list">
      {#each rows as row (row.key)}
        <SubagentRow {row} {onDismiss} {onOpen} />
      {/each}
    </ul>
  </div>
{/if}

<style>
  .sa-group { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  /* Quieter than the drawer's own .sa-head — this is a divider inside a panel
     that already named itself, not a second title competing with it. */
  .sa-group-head { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
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
