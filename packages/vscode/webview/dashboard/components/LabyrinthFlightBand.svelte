<script lang="ts">
  // THE SUB-AGENT BAND — the labelled gap, then one row per delegate.
  //
  // Extracted from LabyrinthFlightChart.svelte at its architecture cap. It is
  // also the right seam on its own terms: this band is the part of the layout
  // the owner asked to read as unmistakable, and it is the only part of the
  // chart with a SECOND fade dimension (a spend chip fades whole delegate rows,
  // not individual ticks), so keeping it beside the plain marks meant one file
  // carrying two highlight models.
  //
  // Every coordinate is labyrinthChart.ts's. Nothing is decided here.
  // Colours are theme vars ONLY.
  import type { FlightChart } from './labyrinthChart';

  let { chart, dimLanes }: {
    chart: FlightChart;
    /** Delegate rows to fade — `first` indices, as a spend chip reports them. */
    dimLanes: ReadonlySet<number>;
  } = $props();
</script>

<!-- THE GAP. Not decoration: it is what makes delegated work read as a
     different thing from the top-level agent's own. -->
<line class="fl-gap" x1={chart.padLeft} y1={chart.gapY + 23} x2={chart.width - chart.padRight} y2={chart.gapY + 23} />
<text class="fl-gap-label" x={chart.padLeft} y={chart.gapY + 15}>{chart.gapLabel}</text>

{#each chart.spans as s, i (i)}<!-- by position: two spans can share `first` (t-vikozs) -->
  {@const laneDim = dimLanes.has(s.first)}
  <path class="fl-depart" class:dim={laneDim} d={s.depart} />
  <!-- The label and the bar share EXACTLY one y, so "the label is on its own
       row" is a checkable equality rather than a look. The TEXT and its x are
       `bandLabel`'s: the indent arrow and the live marker are widths, and a
       width composed here is a width the gutter budget cannot see. -->
  <text class="fl-agent-label" class:nested={s.indent > 0} class:open={s.open} class:dim={laneDim}
    data-agent={s.first} x={s.labelX} y={s.y}>{s.label}</text>
  <line class="fl-span" class:open={s.open} class:dim={laneDim} data-agent={s.first} x1={s.x1} y1={s.y} x2={s.x2} y2={s.y}>
    <title>{s.detail}</title>
  </line>
  {#if s.open}
    <circle class="fl-open-end" class:dim={laneDim} data-agent={s.first} cx={s.x2} cy={s.y} r="4"><title>{s.detail}</title></circle>
  {:else}
    <path class="fl-rejoin" class:dim={laneDim} d={s.rejoin} />
  {/if}
{/each}

<!-- A run that delegated nothing says so, rather than leaving a blank band the
     reader has to interpret. -->
{#if chart.spans.length === 0 && chart.agentLanes.length === 0}
  <text class="fl-row-label fl-row-sm" x="8" y={chart.gapY + 40}>no delegated runs</text>
{/if}

<style>
  .fl-gap { stroke: var(--og-border); stroke-width: 1.4; stroke-dasharray: 2 4; }
  .fl-gap-label { fill: var(--og-text-muted); font-size: 10px; letter-spacing: 0.06em; }
  .fl-depart, .fl-rejoin { stroke: var(--og-accent-2); stroke-width: 1.2; stroke-dasharray: 4 3; opacity: 0.8; fill: none; }
  .fl-agent-label { fill: var(--og-text-secondary); font-size: 10px; dominant-baseline: central; }
  .fl-agent-label.nested { fill: var(--og-text-muted); font-size: 9.5px; }
  /* A delegate that never reported back is the one fact on this band worth a
     colour of its own — it is still running as the run is being read. */
  .fl-agent-label.open { fill: var(--og-warning); }
  .fl-span { stroke: var(--og-accent-2); stroke-width: 4; opacity: 0.5; stroke-linecap: round; }
  .fl-span.open { stroke: var(--og-warning); stroke-dasharray: 7 4; opacity: 1; }
  .fl-open-end { fill: var(--og-surface); stroke: var(--og-warning); stroke-width: 1.6; }
  /* A delegate ROW fades whole — bar, label, departure and rejoin together — so
     a hovered spend chip dims the lanes its work never touched. */
  .fl-span.dim, .fl-agent-label.dim, .fl-depart.dim, .fl-rejoin.dim, .fl-open-end.dim { opacity: 0.15; }
  /* Declared here too: Svelte scopes styles per component, so the empty-band
     line cannot inherit the chart's own row-label rule. */
  .fl-row-label { fill: var(--og-text-secondary); font-size: 10px; }
  .fl-row-sm { fill: var(--og-text-muted); font-size: 9.5px; }
</style>
