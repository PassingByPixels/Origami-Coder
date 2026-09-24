<script lang="ts">
  // SubagentTab.svelte — the drawer's EDGE HANDLE: the one piece of the roster
  // that stays on screen when the panel is slid away, plus its running badge.
  //
  // EXTRACTED from SubagentDrawer.svelte at 184/185 (t-dclj7z), when the panel
  // head gained the agent-map button and the Complete band gained its clear
  // action. The split is the family's own: the drawer owns the PANEL and the
  // slide, SubagentGroup.svelte one band, SubagentRow.svelte one row — and the
  // handle is the affordance that exists precisely when none of those are
  // visible, with a whole 20-line pill style of its own.
  interface Props {
    open: boolean;
    /** RUNNING rows only, never the band's length: the band holds queued rows
     *  too, and a badge counting those says "3 running" over a chat with one. */
    running: number;
    onToggle: () => void;
  }
  let { open, running, onToggle }: Props = $props();
</script>

<!-- The handle rides with the panel so it lands flush at the docked edge,
     and is always present so a hidden drawer can be pulled back out. -->
<button
  class="sa-tab"
  aria-expanded={open}
  aria-label={open ? 'Hide sub-agents' : `Show sub-agents (${running} running)`}
  title={open ? 'Hide sub-agents' : `${running} sub-agent${running === 1 ? '' : 's'} running`}
  onclick={onToggle}
>
  <span class="sa-tab-glyph" aria-hidden="true">{open ? '⟨' : '⟩'}</span>
  {#if !open && running > 0}<span class="sa-tab-count">{running}</span>{/if}
</button>

<style>
  .sa-tab {
    flex: 0 0 auto; align-self: center; height: 44px; /* a 44px pill like the todo tab: never stretched to the (off-screen) panel's height */
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
  .sa-tab:hover { color: var(--og-text); background: var(--og-btn-hover); }
  .sa-tab-glyph { font-size: 10px; line-height: 1; }
  .sa-tab-count { font-size: 9px; font-weight: 600; color: var(--og-accent); }
</style>
