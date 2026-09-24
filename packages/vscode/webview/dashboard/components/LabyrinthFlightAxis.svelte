<script lang="ts">
  // THE ANNOTATIONS THAT CROSS EVERY ROW — where the cache was lost, where each
  // user turn started, and the clock under the picture.
  //
  // Extracted from LabyrinthFlightChart.svelte at its architecture cap, and it
  // is the right seam on its own terms: this is the markup half of the split
  // labyrinthChart.ts already made when it handed those three to labyrinthAxis.ts.
  // None of them sits on a row — each is a rule ACROSS every row, derived from
  // the clock alone, and all of them vanish together when the run cannot be
  // clock-ordered. One gate, one file, on both sides of the seam now.
  //
  // The IDLE shading stays with the parent on purpose. It is the same family of
  // annotation, but it is BACKGROUND: it must be painted before any tick, and
  // everything here is painted after them.
  //
  // Every coordinate is labyrinthChart.ts's. Nothing is decided here.
  // Colours are theme vars ONLY.
  import type { FlightChart } from './labyrinthChart';

  let { chart }: { chart: FlightChart } = $props();
</script>

<!-- Where a fresh prefill was billed. Drawn over the rows it costs, under the
     turn lines, and always carrying its own derived reason as a tooltip. -->
{#each chart.losses as loss (loss.ordinal)}
  <line class="fl-loss" data-loss={loss.ordinal} x1={loss.x} y1={chart.top} x2={loss.x} y2={chart.gapY}>
    <title>Cache lost here — click the step to read why</title>
  </line>
{/each}

<!-- Turn lines over every tick: a reply lands a second after its prompt and
     would otherwise shadow the line that marks the turn. -->
{#each chart.turns as t (t.ordinal)}
  <line class="fl-turn" data-turn={t.ordinal} x1={t.x} y1={chart.top} x2={t.x} y2={chart.chartBottom} />
  {#if !t.labelHidden}
    <text class="fl-turn-label" text-anchor={t.anchor} x={t.anchor === 'end' ? t.x - 3 : t.x + 3} y={chart.top - 4}>{t.label}</text>
  {/if}
{/each}

{#each chart.axis as a, i (i)}
  <text class="fl-axis-label" x={a.x} y={chart.chartBottom + 18}>{a.label}</text>
{/each}
<line class="fl-axis-rule" x1={chart.padLeft} y1={chart.chartBottom} x2={chart.width - chart.padRight} y2={chart.chartBottom} />

<style>
  .fl-loss { stroke: var(--og-warning); stroke-width: 1.2; stroke-dasharray: 2 3; opacity: 0.85; }
  .fl-turn { stroke: var(--og-text-muted); stroke-width: 1; stroke-dasharray: 3 3; opacity: 0.6; }
  .fl-turn-label { fill: var(--og-text-muted); font-size: 9px; }
  .fl-axis-label { fill: var(--og-text-muted); font-size: 10px; text-anchor: middle; }
  .fl-axis-rule { stroke: var(--og-border); stroke-width: 1; }
</style>
