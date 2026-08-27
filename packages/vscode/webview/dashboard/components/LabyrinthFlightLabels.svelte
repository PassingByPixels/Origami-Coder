<script lang="ts">
  // The labels ONE flight marker prints under itself: the caption, the inline
  // detail rows and the time-axis clock. Extracted from LabyrinthNode.svelte,
  // which was at its architecture cap when thread's furniture had to start
  // budgeting itself against the branch-column pitch.
  //
  // It is the only consumer of the node's four density props, and flight is
  // the DETAIL view: the rows the inspector shows one step at a time, shown
  // inline. Absent fields contribute no row at all — and where the strip is
  // too dense to print them legibly they are DROPPED, never overlapped.
  // Colours are theme vars ONLY.
  import {
    truncate, stepCaption, formatClock, flightDetail,
    FLIGHT_CLOCK_Y, FLIGHT_CAPTION_DY, FLIGHT_DETAIL_DY, FLIGHT_DETAIL_ROW, FLIGHT_CAPTION_CHARS,
    type LayoutStep,
  } from './labyrinthLayout';

  let {
    step, x, y, selected, clockY = FLIGHT_CLOCK_Y, crowded = false, captionHidden = false, clockHidden = false,
  }: {
    step: LayoutStep;
    x: number;
    y: number;
    selected: boolean;
    clockY?: number;
    crowded?: boolean;
    captionHidden?: boolean;
    clockHidden?: boolean;
  } = $props();

  let detail = $derived(crowded ? [] : flightDetail(step));
  let clock = $derived(formatClock(step.startedAt));
</script>

{#if !captionHidden}<text class="caption" class:is-selected={selected} {x} y={y + FLIGHT_CAPTION_DY} text-anchor="middle">
  {truncate(stepCaption(step), FLIGHT_CAPTION_CHARS)}
</text>{/if}
{#each detail as row, i (i)}
  <text class="detail" class:is-selected={selected} {x} y={y + FLIGHT_DETAIL_DY + i * FLIGHT_DETAIL_ROW} text-anchor="middle">{row}</text>
{/each}
{#if clock && !clockHidden}<text class="meta" {x} y={clockY} text-anchor="middle">{clock}</text>{/if}

<style>
  /* `color` is inherited from the node group's tone class, which still owns it. */
  .caption { font-size: 13px; fill: var(--og-text-secondary); }
  .caption.is-selected { fill: var(--og-text); font-weight: 600; }
  .meta { font-size: 11px; fill: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  /* Quieter than the caption so the strip still reads as a timeline first and
     a data table second. */
  .detail { font-size: 10px; fill: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .detail.is-selected { fill: var(--og-text-secondary); }
</style>
