<script lang="ts">
  // SideQuestRow.svelte (t-yyz5je) — ONE side quest as one object in the
  // drawer, in the round-8 rail language: id, title and age on the first line,
  // status and one line of summary under it. Extracted from SideQuestsDrawer
  // .svelte so that file keeps the panel and the slide, and this keeps the row.
  //
  // STATUS is always "open": the host sends only open quests
  // (sideQuestsPane.ts readOpenSideQuests), so a started quest leaves the list.
  // The word is still drawn because it is the mockup's slot and a true fact.
  import type { SideQuest } from '../panes/sideQuestProps';
  import { questAge } from '../panes/sideQuestAge';
  import { tip } from '../../shared/warmTip';

  interface Props {
    quest: SideQuest;
    /** True while this quest is open beside the drawer. */
    selected: boolean;
    onOpen: () => void;
  }
  let { quest, selected, onOpen }: Props = $props();

  const age = $derived(questAge(quest.created));
</script>

<button class="sq-row" class:sel={selected} aria-current={selected ? 'true' : undefined} use:tip={quest.summary || quest.title} onclick={onOpen}>
  <span class="sq-row-id">{quest.id}</span>
  <span class="sq-row-title">{quest.title}</span>
  {#if age}<span class="sq-row-age">{age}</span>{/if}
  <span class="sq-row-status">open</span>
  {#if quest.summary}<span class="sq-row-summary">{quest.summary}</span>{/if}
</button>

<style>
  .sq-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    column-gap: 7px;
    row-gap: 1px;
    align-items: baseline;
    min-width: 0;
    padding: 5px 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    transition: background-color 0.16s ease;
  }
  .sq-row:hover, .sq-row.sel { background: var(--og-bg); border-color: var(--og-border); }
  .sq-row-id { grid-column: 1; font-size: 9px; font-weight: 600; color: var(--og-accent); }
  /* One line, clipped: the whole brief is in the popup. */
  .sq-row-title, .sq-row-summary { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sq-row-title { grid-column: 2; font-size: 10.5px; color: var(--og-text); }
  .sq-row-age { grid-column: 3; font-size: 9px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .sq-row-status { grid-column: 1; grid-row: 2; font-size: 8px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--og-text-muted); }
  .sq-row-summary { grid-column: 2 / span 2; grid-row: 2; font-size: 9.5px; color: var(--og-text-muted); }
  @media (prefers-reduced-motion: reduce) { .sq-row { transition: none; } }
</style>
