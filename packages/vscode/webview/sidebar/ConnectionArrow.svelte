<script lang="ts">
  // One paging arrow of the connections strip. t-ysud6n: it shows how many
  // tiles are hidden on its side, so a tile scrolled out of view does not read
  // as a missing tile. Extracted from ConnectionCarousel.svelte (at its cap).
  let { dir, hidden, onclick }: { dir: -1 | 1; hidden: number; onclick: () => void } = $props();
  const name = $derived(`${dir < 0 ? 'Previous' : 'Next'} connections${hidden > 0 ? ` (${hidden} more)` : ''}`);
</script>

<button class="conn-arrow" class:more={hidden > 0} type="button" aria-label={name} {onclick}
  >{#if dir < 0}&lsaquo;{/if}{#if hidden > 0}<span class="conn-more">{hidden}</span>{/if}{#if dir > 0}&rsaquo;{/if}</button>

<style>
  .conn-arrow {
    flex: 0 0 auto;
    min-width: 20px;
    height: 26px;
    padding: 0 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 1px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    font-family: inherit;
  }
  .conn-arrow:hover { background: var(--og-btn-hover); color: var(--og-text); }
  /* Tiles wait on this side: the arrow takes the accent, so it reads as "more here". */
  .conn-arrow.more { border-color: var(--og-accent); color: var(--og-text); }
  .conn-more { font-size: 9px; font-weight: 600; }
</style>
