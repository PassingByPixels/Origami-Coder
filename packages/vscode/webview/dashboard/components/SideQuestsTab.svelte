<script lang="ts">
  // SideQuestsTab.svelte — the Side quests drawer's EDGE HANDLE, and its open
  // count. A sibling of SubagentTab.svelte in every respect except the label:
  // two drawers on one rail must present the same affordance, or the second one
  // reads as a different kind of thing.
  //
  // The count is OPEN QUESTS, and it is the only thing this feature ever does
  // unasked. No toast, no sound, no auto-open: a suggestion the owner has not
  // asked to see must cost him a number on a tab and nothing more.
  interface Props {
    open: boolean;
    /** Open quests. Never the row count of a filtered view — the two are the
     *  same today, and a badge that could drift from the list is a bug in
     *  waiting. */
    count: number;
    onToggle: () => void;
  }
  let { open, count, onToggle }: Props = $props();
</script>

<button
  class="sq-tab"
  aria-expanded={open}
  aria-label={open ? 'Hide side quests' : `Show side quests (${count} open)`}
  title={open ? 'Hide side quests' : `${count} side quest${count === 1 ? '' : 's'} waiting`}
  onclick={onToggle}
>
  <span class="sq-tab-glyph" aria-hidden="true">{open ? '⟨' : '⟩'}</span>
  {#if !open && count > 0}<span class="sq-tab-count">{count}</span>{/if}
</button>

<style>
  .sq-tab {
    flex: 0 0 auto; align-self: center; height: 44px; /* the 44px pill both left-rail drawers use */
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: 18px;
    padding: 0;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-left: none;
    border-radius: 0 6px 6px 0;
    cursor: pointer;
    font-family: inherit;
  }
  .sq-tab:hover { color: var(--og-text); background: var(--og-btn-hover); }
  .sq-tab-glyph { font-size: 10px; line-height: 1; }
  .sq-tab-count { font-size: 9px; font-weight: 600; color: var(--og-accent); }
</style>
