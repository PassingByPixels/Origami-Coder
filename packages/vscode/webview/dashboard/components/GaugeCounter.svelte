<script lang="ts">
  // THE ROLLING PERCENTAGE on the context gauge (CHANGES.md round 2, change 27).
  //
  // One column of ten digits per place, each translated so the digit in play
  // sits on the line. A change moves the columns rather than rewriting the
  // text, so the number reads as counting rather than flickering.
  //
  // Its own file because InputBar.svelte is at its cap, and because the ring
  // and the click-to-compact fuse must stay exactly as they are: this file
  // replaces the `<span class="ctx-pct">`'s TEXT, nothing else about the gauge.
  //
  // The digit height comes from a CSS custom property, not a measurement: the
  // column clips to its content box, and in a webview that has not laid out
  // yet (a grid cell that mounts hidden) a measured line-height reads 0 and
  // all ten numbers show at once.
  import { columnOffsets, digitAt, placesOf } from './gaugeCounter';

  interface Props {
    value: number;
    /** The digit column's height in px — one line of the gauge's own type. */
    height?: number;
  }
  let { value, height = 13 }: Props = $props();

  let places = $derived(placesOf(value));
  let columns = $derived(
    Array.from({ length: places }, (_, p) => columnOffsets(digitAt(value, p, places), height)),
  );
</script>

<!-- aria-hidden: ten numbers per place is not a reading. The gauge's own
     aria-label already carries the percentage in words. -->
<span class="counter" style="height: {height}px" aria-hidden="true">
  {#each columns as offsets, place (place)}
    <span class="counter-digit" style="height: {height}px">
      {#each offsets as offset, digit (digit)}
        <span class="counter-num" style="transform: translateY({offset}px)">{digit}</span>
      {/each}
    </span>
  {/each}
</span><span class="counter-sr">{value}</span>

<style>
  .counter {
    display: inline-flex;
    overflow: hidden;
    line-height: 1;
    vertical-align: middle;
  }
  .counter-digit {
    position: relative;
    width: 1ch;
    font-variant-numeric: tabular-nums;
  }
  .counter-num {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 420ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  @media (prefers-reduced-motion: reduce) {
    .counter-num { transition: none; }
  }
  /* The plain number, for anything that reads text rather than pixels — a DOM
     probe, a test, a copy of the pane. Off-screen, never laid out. */
  .counter-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
