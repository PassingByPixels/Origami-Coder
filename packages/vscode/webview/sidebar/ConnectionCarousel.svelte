<script lang="ts">
  // THE CONNECTIONS STRIP as a snap carousel (Mock-Redesign/CHANGES.md
  // change 4). Arrows page it, the tiles carry the provider NAME on two short
  // lines instead of initials, and Add is a plus icon OUTSIDE the track, so it
  // never scrolls out of reach.
  //
  // EXTRACTED from ControlStrip.svelte rather than added to it: that file sat
  // one line under its 1256 cap, and the cap comment there names the
  // connection surface as its seam. This takes the whole surface — the grid,
  // the Add control and the empty state — so the strip keeps one job.
  //
  // The FIT is the point of the component. Tiles are not a fixed width: the
  // track is measured and a whole number of tiles is made to span it exactly,
  // so no sliver of a next tile is ever visible at any sidebar width. All of
  // that arithmetic is connectionCarouselFit.ts, where it can be tested —
  // jsdom has no layout, so nothing here can be.
  import ConnectionPill from './ConnectionPill.svelte';
  import { tip } from '../shared/warmTip';
  import {
    CONN_GAP, fitTiles, nameLines, pageTarget, settleTarget, type ConnFit,
  } from './connectionCarouselFit';

  interface Tile {
    id: string;
    title: string;
    label: string;
    light: 'green' | 'red' | 'yellow' | '';
    open: boolean;
    /** Not a provider — a dotted card (Claude Code). It rides IN the track
     *  with the rest (t-qhzy4k): outside it, it read as a second control
     *  beside Add and cost the track a card's worth of width. */
    dotted?: boolean;
    inuse?: boolean; // change 30 — this provider is the one the active chat's model is on.
  }
  let { tiles, onPick, onAdd }: { tiles: Tile[]; onPick: (id: string) => void; onAdd: () => void } = $props();

  let trackEl: HTMLDivElement | undefined = $state();
  let fit = $state<ConnFit>(fitTiles(0));
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  function measure(): void {
    if (!trackEl) return;
    fit = fitTiles(trackEl.clientWidth);
  }

  // Re-measure whenever the track exists or the tile count changes; a resize
  // does the rest. (A ResizeObserver would be the tidier instrument, but the
  // sidebar's width changes with the whole panel, so `resize` sees it.)
  $effect(() => {
    void tiles.length;
    void trackEl;
    measure();
  });

  function page(dir: number): void {
    if (!trackEl) return;
    trackEl.scrollTo({
      left: pageTarget(trackEl.scrollLeft, dir, fit, trackEl.scrollWidth, trackEl.clientWidth),
      behavior: 'smooth',
    });
  }

  // A manual drag can rest anywhere; pull it back to a tile start once it has
  // stopped, or the strip shows a cut tile the arrows would never leave it on.
  function onScroll(): void {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (!trackEl) return;
      const target = settleTarget(trackEl.scrollLeft, fit, trackEl.scrollWidth, trackEl.clientWidth);
      if (Math.abs(target - trackEl.scrollLeft) > 1) trackEl.scrollTo({ left: target, behavior: 'smooth' });
    }, 140);
  }
</script>

<svelte:window onresize={measure} />

{#if tiles.length > 0}
  <div class="conn-carousel" style="--conn-tile-w: {fit.width.toFixed(2)}px; --conn-gap: {CONN_GAP}px;">
    <button class="conn-arrow" type="button" aria-label="Previous connections" onclick={() => page(-1)}>&lsaquo;</button>
    <div class="conn-track provider-grid" role="list" aria-label="Providers" bind:this={trackEl} onscroll={onScroll}>
      {#each tiles as t (t.id)}
        <ConnectionPill
          label={t.label}
          lines={nameLines(t.title)}
          dotted={t.dotted}
          inuse={t.inuse}
          title={t.title}
          light={t.light}
          open={t.open}
          onclick={() => onPick(t.id)}
        />
      {/each}
    </div>
    <button class="conn-arrow" type="button" aria-label="Next connections" onclick={() => page(1)}>&rsaquo;</button>
  </div>
  <!-- Outside the track on purpose: a scrolled-away Add is an Add nobody
       finds. Icon-only, because the strip's room belongs to the connections. -->
  <button
    class="add-provider add-icon"
    aria-label="Add connection"
    use:tip={'Add another provider (OpenRouter / OpenAI / xAI / Anthropic / a 2nd local)'}
    onclick={onAdd}
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M12 5v14" /><path d="M5 12h14" />
    </svg>
  </button>
{:else}
  <!-- Empty state: no providers yet. LM Studio is the default; its setup is
       endpoint-only (the model is chosen in the chat pane). -->
  <button class="add-provider" onclick={onAdd}>＋ Add provider</button>
{/if}

<style>
  .conn-carousel {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .conn-track {
    display: flex;
    flex-wrap: nowrap;
    gap: var(--conn-gap);
    overflow-x: auto;
    /* Snap to tile starts, so a drag also stops on whole tiles. */
    scroll-snap-type: x mandatory;
    scroll-behavior: smooth;
    scrollbar-width: none;
    flex: 1 1 auto;
    min-width: 0;
    padding: 2px 0;
  }
  .conn-track::-webkit-scrollbar { display: none; }
  .conn-arrow {
    flex: 0 0 auto;
    width: 20px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
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

  .add-provider {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 5px 12px;
    font-size: 11px;
    font-weight: 600;
    color: var(--og-chat);
    background: var(--og-input-bg);
    border: 1px dashed color-mix(in srgb, var(--og-chat) 55%, var(--og-border));
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.12s ease, background 0.12s ease;
  }
  .add-provider:hover { border-color: var(--og-chat); background: var(--og-surface-alt); }
  /* 26px, the height of the squares it sits beside (t-qhzy4k) — the old
     "+ Add" button it replaced was 25px tall. */
  .add-provider.add-icon { flex: 0 0 auto; width: 26px; height: 26px; padding: 0; }
  .add-provider.add-icon svg { width: 12px; height: 12px; }
</style>
