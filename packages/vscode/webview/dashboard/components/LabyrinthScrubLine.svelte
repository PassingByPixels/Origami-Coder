<script lang="ts">
  // THE TIME CURSOR — one rule down the whole picture, with the snapped step's
  // clock riding its top.
  //
  // Markup only. WHERE it sits is labyrinthScrub.ts's answer and the chart's
  // state; nothing is decided here. Drawn LAST by its parent, so it reads over
  // every tick, span and turn line rather than being buried under one.
  //
  // It carries NO transition and no animation: a cursor that eased into place
  // would lag the pointer that is dragging it, and it means the view has nothing
  // for a reduced-motion preference to switch off.
  //
  // `pointer-events: none` on all three parts is load-bearing — the cursor sits
  // over the ticks, and a cursor that swallowed the clicks it exists to make
  // easier would be worse than no cursor.
  //
  // The chip shares the 26-unit band above the first row with LabyrinthBreaks'
  // model tag (fixed y 12) and the turn labels. It is opaque and drawn last, so
  // where the reader has parked the cursor on top of one, the cursor wins — it
  // is the thing under their hand, and it moves off again.
  //
  // Colours are theme vars ONLY.
  import type { ScrubStop } from './labyrinthScrub';

  let { chart, scrub, label }: {
    chart: { width: number; top: number; chartBottom: number };
    scrub: ScrubStop;
    label: string;
  } = $props();

  /** Half the chip, so it is clamped inside the viewBox instead of clipped. */
  const HALF = 25;
  let cx = $derived(Math.min(chart.width - HALF - 2, Math.max(HALF + 2, scrub.x)));
</script>

<line class="fl-scrub" data-ordinal={scrub.ordinal}
  x1={scrub.x} y1={chart.top - 8} x2={scrub.x} y2={chart.chartBottom} />
<rect class="fl-scrub-chip" x={cx - HALF} y={chart.top - 22} width={HALF * 2} height="14" rx="3" />
<text class="fl-scrub-time" x={cx} y={chart.top - 11.5}>{label}</text>

<style>
  .fl-scrub { stroke: var(--og-accent); stroke-width: 1.4; opacity: 0.95; pointer-events: none; }
  .fl-scrub-chip { fill: var(--og-accent); pointer-events: none; }
  .fl-scrub-time { fill: var(--og-bg); font-size: 9px; font-weight: 600; text-anchor: middle; pointer-events: none; }
</style>
