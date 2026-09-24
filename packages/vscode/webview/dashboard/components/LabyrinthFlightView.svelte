<script lang="ts">
  // FLIGHT, as the analytics screen the owner approved: the prompts that drove
  // the run, what it spent its steps on by category, and one fit-to-width
  // timeline with the delegated work in a band of its own beneath a labelled
  // gap. It replaces the old wide strip, which grew 150px per step and had to be
  // scrolled to be read at all.
  //
  // WHAT THIS FILE OWNS: composition, zoom, and which step is picked. Every
  // number and every coordinate comes from a pure leaf — labyrinthChart.ts
  // (geometry), labyrinthAgentBand.ts (the band's rows), labyrinthCategory.ts
  // (the counts), labyrinthCache.ts (the cache half) — so none of it needs a DOM
  // to be checked, and this file cannot quietly disagree with any of them.
  //
  // THE HEADER IS NOT A SECOND SPEND READOUT. Run spend — raw, cached, real,
  // cost, models — is LabyrinthUsageStrip.svelte's, and it is already on screen
  // directly above this view. Repeating those figures here would give a reader
  // two places to look and two chances to disagree, so the header carries only
  // what the strip cannot say: the run's SHAPE. It renders through
  // LabyrinthStatPills.svelte, which IS the strip's own row component, so the
  // two rows share one rhythm by construction rather than by resemblance.
  //
  // Colours are theme vars ONLY.
  import { agentRows } from './labyrinthAgentBand';
  import { categoryCounts, type Category } from './labyrinthCategory';
  import { flightChart } from './labyrinthChart';
  import { cacheLosses } from './labyrinthCache';
  import { formatClock, formatDuration } from './labyrinthFormat';
  import { isThreshold, type LayoutStep } from './labyrinthLayout';
  import { finiteTime } from './labyrinthSpans';
  import type { HighlightTarget } from './labyrinthHighlight';
  import LabyrinthCachePanel from './LabyrinthCachePanel.svelte';
  import LabyrinthFlightCards from './LabyrinthFlightCards.svelte';
  import LabyrinthFlightChart from './LabyrinthFlightChart.svelte';
  import LabyrinthStatPills, { type StatCell } from './LabyrinthStatPills.svelte';

  /** Declared BEFORE the props block: a default value is evaluated at init, so
   *  a const declared after it would be read inside its own dead zone. */
  const EMPTY: ReadonlySet<number> = new Set<number>();

  let {
    steps, selected, onSelect, dim, dimLanes = EMPTY, width, onHighlight, claudeRun = false,
  }: {
    steps: readonly LayoutStep[];
    selected: number | null;
    onSelect: (step: LayoutStep) => void;
    /** Ordinals to fade — what the hovered pill, bar or spend chip is NOT about. */
    dim: ReadonlySet<number>;
    /** Delegate ROWS to fade, by `first` index — a spend chip's own answer. */
    dimLanes?: ReadonlySet<number>;
    /** The container's own measured width in px; 0 before the first measure. */
    width: number;
    /** Point at the part of the chart a pill or bar is about; null on leave. */
    onHighlight?: (target: HighlightTarget | null) => void;
    /** This run is a Claude Code transcript — passed through to the cache panel. */
    claudeRun?: boolean;
  } = $props();

  /** Zoom multiplies the RENDERED width only; 1 is fit-to-width by construction. */
  const MAX_ZOOM = 6;
  const STEP = 1.6;
  let zoom = $state(1);
  let hovered: Category | null = $state(null);

  let rows = $derived(agentRows(steps));
  let losses = $derived(cacheLosses(steps, claudeRun));
  let lossOrdinals = $derived(new Set(losses.map((l) => l.ordinal)));
  let chart = $derived(flightChart({ steps, rows, width, lossOrdinals }));
  let categories = $derived(categoryCounts(steps));
  /** An EVENT, not a category: it goes to the cards' banner and to the spine. */
  let compactions = $derived(steps.filter((s) => s.kind === 'compaction'));
  let prompts = $derived(steps
    .filter((s) => s.kind === 'prompt' && (s.depth ?? 0) === 0)
    .map((s) => ({ ordinal: s.ordinal, title: s.title, ...(formatClock(s.startedAt) ? { when: formatClock(s.startedAt) } : {}) })));

  let failed = $derived(steps.filter(isThreshold).length);
  let startsAt = $derived(steps.map((s) => finiteTime(s.startedAt)).filter((n): n is number => n !== undefined));
  let endsAt = $derived(steps.map((s) => finiteTime(s.endedAt) ?? finiteTime(s.startedAt)).filter((n): n is number => n !== undefined));
  /** Absent when the run cannot be clock-ordered — never a fabricated 0m. */
  let spanText = $derived(chart.timeBased && startsAt.length && endsAt.length
    ? formatDuration(Math.max(...endsAt) - Math.min(...startsAt))
    : undefined);

  /** The run's SHAPE, in the spend strip's own cells. Only the two that map onto
   *  a drawable set of ticks are hoverable; the rest would light nothing. */
  let cells = $derived([
    { key: 'steps', value: steps.length.toLocaleString(), label: 'steps' },
    { key: 'turns', value: String(prompts.length), label: prompts.length === 1 ? 'turn' : 'turns' },
    ...(spanText ? [{ key: 'span', value: spanText, label: 'span' }] : []),
    { key: 'delegated', value: String(rows.length), label: 'delegated', title: 'Hover to light the delegate spawns on the chart' },
    ...(failed ? [{ key: 'failed', value: String(failed), label: 'failed', tone: 'warn' as const, title: 'Hover to light the failed steps on the chart' }] : []),
  ] as StatCell[]);

  const byOrdinal = (ordinal: number): LayoutStep | undefined => steps.find((s) => s.ordinal === ordinal);
  function pick(ordinal: number): void {
    const step = byOrdinal(ordinal);
    if (step) onSelect(step);
  }
  function pillHover(key: string | null): void {
    if (key === 'delegated') onHighlight?.({ kind: 'category', category: 'Delegate' });
    else if (key === 'failed') onHighlight?.({ kind: 'errors' });
    else onHighlight?.(null);
  }
  function barHover(category: Category | null): void {
    hovered = category;
    onHighlight?.(category ? { kind: 'category', category } : null);
  }

  let picked = $derived(selected === null ? undefined : byOrdinal(selected));
  let axisLabel = $derived(chart.timeBased && chart.axis.length
    ? `Time axis ${chart.axis[0]!.label} → ${chart.axis[chart.axis.length - 1]!.label}${spanText ? ` · ${spanText}` : ''}`
    : 'Order axis — these steps carry no usable timestamps');
</script>

<div class="fl-view">
  <div class="fl-head">
    <LabyrinthStatPills {cells} onHover={pillHover} />
  </div>

  <LabyrinthFlightCards {prompts} {categories} {hovered} {compactions}
    headline={steps.length.toLocaleString()}
    subhead={`steps drawn${failed ? ` · ${failed} failed` : ''}${spanText ? ` · ${spanText} span` : ''}${rows.length ? ` · ${rows.length} delegated` : ''}`}
    onSelect={pick} onHover={barHover} />

  <div class="fl-axis-head">
    <span class="fl-axis-name">{axisLabel}</span>
    <span class="fl-zoom">
      <button class="fl-btn" title="Zoom out" onclick={() => (zoom = Math.max(1, zoom / STEP))}>−</button>
      <button class="fl-btn" title="Zoom in" onclick={() => (zoom = Math.min(MAX_ZOOM, zoom * STEP))}>+</button>
      <button class="fl-btn" onclick={() => (zoom = 1)}>Reset zoom (fit)</button>
    </span>
  </div>
  <!-- The wrapper scrolls only once zoom has grown the chart past it; at rest
       the chart IS the wrapper's width, so there is nothing to scroll. -->
  <div class="fl-chart-wrap">
    <LabyrinthFlightChart {chart} {steps} {selected} {dim} {dimLanes} onSelect={pick} renderedWidth={chart.width * zoom} />
  </div>

  <div class="fl-foot">
    {#if picked}
      <span class="fl-foot-id">#{picked.ordinal}</span>
      <span class="fl-foot-what">{picked.tool ?? picked.kind} — {picked.title}</span>
      {#if formatClock(picked.startedAt)}<span class="fl-foot-when">{formatClock(picked.startedAt)}</span>{/if}
    {:else}
      <span class="fl-foot-what fl-idle-text">Click a tick on the chart to inspect that step.</span>
    {/if}
  </div>

  <LabyrinthCachePanel {steps} onSelect={pick} {claudeRun} />
</div>

<style>
  .fl-view { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding: 10px 12px 16px; display: flex; flex-direction: column; gap: 10px; color: var(--og-text); }
  /* THE VIEW SCROLLS, so nothing in it may be squeezed to fit. Without this the
     chart wrapper — the one child with no intrinsic height of its own, because
     the SVG takes its height from its aspect ratio — collapsed to a sliver and
     the whole timeline vanished. Caught on a real render; jsdom has no layout
     engine and could not have caught it. */
  .fl-view > * { flex: 0 0 auto; }
  .fl-head { padding-bottom: 8px; border-bottom: 1px solid var(--og-border); }
  .fl-axis-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-top: 4px; }
  .fl-axis-name { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); font-weight: 600; }
  .fl-zoom { display: flex; gap: 4px; }
  .fl-btn { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text-secondary); border-radius: 4px; padding: 2px 9px; font-size: 10px; cursor: pointer; font-family: inherit; }
  .fl-btn:hover { background: var(--og-btn-hover); color: var(--og-text); }
  .fl-chart-wrap { flex: 0 0 auto; overflow-x: auto; border: 1px solid var(--og-border); border-radius: 6px; background: var(--og-surface); padding: 4px 0; }
  .fl-foot { display: flex; align-items: baseline; gap: 8px; background: var(--og-pane-header); border: 1px solid var(--og-border); border-radius: 6px; padding: 7px 10px; font-size: 11px; }
  .fl-foot-id { font-weight: 600; color: var(--og-chat); font-variant-numeric: tabular-nums; }
  .fl-foot-what { color: var(--og-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .fl-foot-when { color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .fl-idle-text { font-style: italic; color: var(--og-text-muted); }
</style>
