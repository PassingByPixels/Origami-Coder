<script lang="ts">
  // Generic carousel: a scroll-snap track plus prev/next arrows, ported from
  // Mock-Redesign's makeCarousel (CHANGES.md change 7, t-q8zufa). A1's sidebar
  // lane is building a Carousel with the same contract in a worktree this lane
  // cannot see — the lead reconciles the two at merge.
  //
  // Unlike the mock's vanilla-JS version, which had to re-adopt Svelte-added
  // children into a DOM track it built once, this is a real Svelte component:
  // whatever is passed through the default slot is rendered into the track by
  // Svelte itself on every update, so there is no separate "adoption" step —
  // new children just appear.
  // t-qn09vr (round-3 change 50): a two-row grid, fixed-width cards, paging a
  // full screen of COLUMNS per arrow click — not one card at a time, the naive
  // `pageWidth()` behaviour this replaced. The column count reuses fitTiles
  // (webview/sidebar/connectionCarouselFit.ts) rather than a second copy of
  // its floor-division arithmetic; only `.count` is used — the fixed card
  // width is CSS's job, so `.width`'s stretch-to-fill answer is ignored.
  import { fitTiles } from '../../sidebar/connectionCarouselFit';

  interface Props {
    children: import('svelte').Snippet;
    /** > 1 lays the track out as a fixed-row grid instead of one flowing row. */
    rows?: number;
  }
  let { children, rows = 1 }: Props = $props();
  let track: HTMLDivElement | undefined = $state();

  function cardStep(): number {
    const first = track?.firstElementChild as HTMLElement | null;
    return (first?.getBoundingClientRect().width ?? 80) + 4;
  }
  function go(dir: number): void {
    if (!track) return;
    const step = cardStep();
    const fit = fitTiles(track.clientWidth, step - 4, 4);
    track.scrollBy({ left: dir * fit.count * step, behavior: 'smooth' });
  }
</script>

<div class="rd-carousel">
  <button type="button" class="rd-car-arrow" aria-label="Previous" onclick={() => go(-1)}>‹</button>
  <div class="rd-carousel-track" class:rd-car-grid={rows > 1}
    style={rows > 1 ? `grid-template-rows: repeat(${rows}, auto);` : ''} bind:this={track}>
    {@render children()}
  </div>
  <button type="button" class="rd-car-arrow" aria-label="Next" onclick={() => go(1)}>›</button>
</div>

<style>
  .rd-carousel { display: flex; align-items: center; gap: 4px; min-width: 0; height: 100%; }
  .rd-carousel-track {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scroll-behavior: smooth;
    scrollbar-width: none;
    min-width: 0;
    flex: 1 1 auto;
    height: 100%;
  }
  /* `auto` rows (t-ro2ss4), not `1fr`: a sibling pane (RepoDetail.svelte) can
     be taller than this track's own 2*card-height content, and `align-items:
     stretch` on their shared flex row (.am-toppanes) then stretches THIS
     track to match — 1fr rows used to divide that extra height evenly between
     the two card rows, pulling them apart with a visible gap. `auto` keeps
     each row exactly as tall as its cards; `align-content: start` keeps the
     leftover height as space below the two rows instead of between them. */
  .rd-carousel-track.rd-car-grid {
    display: grid;
    grid-auto-flow: column;
    align-content: start;
  }
  .rd-carousel-track::-webkit-scrollbar { display: none; }
  /* height: 100% only for the single-row (flex) case, where the track's own
     height IS definite and stretching a variable-height child to it is the
     point. In grid mode the row tracks are `auto` — sized FROM their content —
     so a percentage height on a child resolves as if unset mid-computation,
     which let grid's own default stretch win and shrink a card (the ghost
     "+ Add repo" button, this track's one direct grid child with no wrapper)
     down to its text size instead of the fixed 52px every card owns already
     (t-ro2ss4). `align-self: start` in grid mode leaves each item at its own
     size instead. */
  .rd-carousel-track:not(.rd-car-grid) :global(> *) { scroll-snap-align: start; flex: 0 0 auto; height: 100%; }
  .rd-carousel-track.rd-car-grid :global(> *) { scroll-snap-align: start; align-self: start; }
  .rd-car-arrow {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
  }
  .rd-car-arrow:hover { background: var(--og-btn-hover); color: var(--og-text); }
</style>
