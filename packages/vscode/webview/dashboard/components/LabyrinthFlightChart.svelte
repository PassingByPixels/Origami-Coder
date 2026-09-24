<script lang="ts">
  // The analytics Flight chart's SVG — markup over labyrinthChart.ts and
  // nothing else. Every x, y, width and height comes from that pure leaf, so
  // "is the sub-agent's label on the same row as its bar?" is answerable in a
  // test with no layout engine, and this file cannot quietly disagree with it.
  //
  // The chart is drawn at the container's measured width (1 user unit = 1 CSS
  // pixel at rest) and the RENDERED width is what zoom changes — never the
  // viewBox. Growing the rendered width past the viewBox makes ticks and text
  // bigger and lets the wrapper scroll; scaling a fixed giant canvas down would
  // shrink every font-size and stroke with the geometry instead.
  //
  // THIS FILE ALSO OWNS THE TIME CURSOR, because the cursor is a pointer and a
  // keyboard on THIS element and nowhere else: the conversion from a clientX to
  // a user unit needs the rect of the very SVG the handlers are bound to. Where
  // the cursor may land is labyrinthScrub.ts's rule and what it looks like is
  // LabyrinthScrubLine.svelte's; the state and the two event surfaces are here.
  // Placing it ends in `onSelect(ordinal)` — the SAME call a tick's own click
  // makes — so the cursor and the ticks cannot select different things.
  //
  // Colours are theme vars ONLY, and every fill arrives as a `var(--og-*)`
  // string from labyrinthCategory.ts / labyrinthTone.ts — there is no palette
  // in this file to drift from theirs.
  import LabyrinthBreaks from './LabyrinthBreaks.svelte';
  import LabyrinthFlightAxis from './LabyrinthFlightAxis.svelte';
  import LabyrinthFlightBand from './LabyrinthFlightBand.svelte';
  import LabyrinthFlightMarks from './LabyrinthFlightMarks.svelte';
  import LabyrinthScrubLine from './LabyrinthScrubLine.svelte';
  import { scrubLabel, scrubStops, scrubXAt, snapScrub, stepScrub, type ScrubStop } from './labyrinthScrub';
  import type { FlightChart, ChartRow } from './labyrinthChart';
  import type { LayoutStep } from './labyrinthLayout';

  let {
    chart, steps, selected, onSelect, dim, dimLanes, renderedWidth,
  }: {
    chart: FlightChart;
    /** LabyrinthBreaks and the cursor's clock read these. */
    steps: readonly LayoutStep[];
    /** Ordinal of the picked step; null = nothing picked. */
    selected: number | null;
    onSelect: (ordinal: number) => void;
    /** Ordinals to FADE — what a hovered pill or category bar is NOT about. */
    dim: ReadonlySet<number>;
    /** Delegate rows to fade — `first` indices, as a spend chip reports them. */
    dimLanes: ReadonlySet<number>;
    /** CSS px to render at. Equals `chart.width` at rest; larger once zoomed. */
    renderedWidth: number;
  } = $props();

  const mid = (row: ChartRow): number => row.y + row.h / 2;
  const rowRail = (row: ChartRow) => ({ y: row.y + row.h, x1: chart.padLeft, x2: chart.width - chart.padRight });

  /** The cursor, in chart USER UNITS — the one coordinate zoom never touches, so
   *  zooming leaves it on the same instant of the run without a second pass. */
  let scrub: ScrubStop | null = $state(null);
  /** Deliberately not `$state`: nothing renders from it. */
  let dragging = false;
  let stops = $derived(scrubStops(chart));
  function place(x: number | null): void {
    const stop = x === null ? null : snapScrub(stops, x);
    // A drag crosses many pixels per tick: re-selecting the step the cursor is
    // already on would fire the inspector dozens of times for one move.
    if (!stop || (scrub && stop.x === scrub.x && stop.ordinal === scrub.ordinal)) return;
    scrub = stop;
    onSelect(stop.ordinal);
  }
  function onKey(ev: KeyboardEvent): void {
    const stop = stepScrub(stops, scrub, ev.key);
    if (!stop) return;
    ev.preventDefault();
    scrub = stop;
    onSelect(stop.ordinal);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<svg
  class="lab-svg fl-chart"
  viewBox="0 0 {chart.width} {chart.height}"
  style="width: {Math.round(renderedWidth)}px;"
  role="group"
  aria-label="Run steps by time and category — drag the cursor, or use the arrow keys, to inspect a step"
  tabindex="0"
  onpointerdown={(ev) => { dragging = true; place(scrubXAt(ev, chart.width)); }}
  onpointermove={(ev) => { if (dragging) place(scrubXAt(ev, chart.width)); }}
  onpointerup={() => (dragging = false)}
  onpointerleave={() => (dragging = false)}
  onpointercancel={() => (dragging = false)}
  onkeydown={onKey}
>
  <!-- Idle first, under everything: it is background, not a mark. -->
  {#each chart.idle as w, i (i)}
    <rect class="fl-idle" x={w.x1} y={chart.top} width={w.x2 - w.x1} height={chart.chartBottom - chart.top} />
    {@const lx = (w.x1 + w.x2) / 2}
    {@const ly = chart.top + (chart.chartBottom - chart.top) / 2}
    <text class="fl-idle-label" x={lx} y={ly} transform={w.narrow ? `rotate(-90 ${lx} ${ly})` : undefined}>{w.label}</text>
  {/each}

  <text class="fl-row-label" x="8" y={mid(chart.allRow) + 4}>{chart.allRow.label}</text>
  <line class="fl-rail" x1={rowRail(chart.allRow).x1} y1={rowRail(chart.allRow).y} x2={rowRail(chart.allRow).x2} y2={rowRail(chart.allRow).y} />
  {#each chart.categoryRows as row (row.key)}
    <text class="fl-row-label fl-row-sm" x="8" y={mid(row) + 3}>{row.label}</text>
    <line class="fl-rail" x1={rowRail(row).x1} y1={rowRail(row).y} x2={rowRail(row).x2} y2={rowRail(row).y} />
  {/each}

  <LabyrinthFlightMarks {chart} {selected} {onSelect} {dim} />

  <LabyrinthFlightBand {chart} {dimLanes} />

  <!-- WHERE THE RUN CHANGED HANDS. The same component thread and corridor draw
       it with, over the same `modelBreaks` rule, so the three views cannot
       disagree about which switch happened where. A model change is also one of
       the cache-loss causes the panel below derives, and this is where the
       reader sees it on the axis. -->
  <LabyrinthBreaks {steps} mode="flight" points={chart.spine.map((p, i) => ({ ...p, step: steps[i]! }))}
    box={{ width: chart.width, height: chart.height }} />

  <!-- Cache losses, turn lines and the clock. AFTER the break rules, which run
       past the axis line: a dashed rule printed through a clock label is the one
       collision in this band a reader actually notices. -->
  <LabyrinthFlightAxis {chart} />

  <!-- LAST: the cursor is the thing under the reader's hand. -->
  {#if scrub}
    <LabyrinthScrubLine {chart} {scrub} label={scrubLabel(scrub, steps)} />
  {/if}
</svg>

<style>
  /* No height attribute: the rendered WIDTH is set inline and the height follows
     the intrinsic aspect ratio, so zoom needs no second geometry pass. */
  .fl-chart { display: block; height: auto; font-family: var(--vscode-editor-font-family, monospace); touch-action: none; }
  /* The chart takes focus so the arrow keys can drive the cursor; say so. */
  .fl-chart:focus-visible { outline: 1px solid var(--og-accent); outline-offset: 2px; }
  .fl-idle { fill: var(--og-border); opacity: 0.32; }
  .fl-idle-label { fill: var(--og-text-muted); font-size: 9px; text-anchor: middle; }
  .fl-row-label { fill: var(--og-text-secondary); font-size: 10px; }
  .fl-row-sm { fill: var(--og-text-muted); font-size: 9.5px; }
  .fl-rail { stroke: var(--og-border); stroke-width: 1; opacity: 0.6; }
</style>
