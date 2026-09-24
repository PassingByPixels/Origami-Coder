<script lang="ts">
  // ONE STAT ROW, used everywhere the Labyrinth prints a row of figures.
  //
  // Extracted from LabyrinthSpendHeadline.svelte's own second row when the
  // analytics Flight view needed a header of the same shape. The owner's note
  // was that the new header must not invent a style of its own — so it does not
  // get one: this component IS the spend strip's row, moved, and the spend strip
  // now renders through it. One rhythm, one place to change it.
  //
  // The rhythm, unchanged from where it came: VALUE THEN LABEL on one column
  // pitch, equal min-width and padding so cells in stacked rows line up where
  // the counts allow, tabular figures, a quiet rule between cells. A table, not
  // a row of coloured chips.
  //
  // Hover is OPTIONAL and reports the cell's own key. That is what lets the
  // Flight header light the matching ticks on the chart the same way a spend
  // chip already lights its branch (labyrinthHighlight.ts) — the highlight
  // itself is never decided here.
  // Colours are theme vars ONLY.

  export interface StatCell {
    /** Render key, and what `onHover` reports. Unique within one row. */
    key: string;
    value: string;
    label: string;
    /** `strong` is the figure the reader takes away; `warn` is a floor/estimate. */
    tone?: 'strong' | 'warn';
    title?: string;
  }

  let { cells, onHover }: {
    cells: readonly StatCell[];
    /** The cell the pointer or focus is on; null when it leaves. Absent = inert. */
    onHover?: (key: string | null) => void;
  } = $props();

  /** Hover AND focus, so a cell reached by keyboard lights what a pointer does —
   *  the same pairing LabyrinthUsageStrip's chips use. */
  const over = (key: string) => (onHover
    ? {
      onmouseenter: () => onHover(key), onmouseleave: () => onHover(null),
      onfocus: () => onHover(key), onblur: () => onHover(null),
      tabindex: 0,
    }
    : {});
</script>

{#if cells.length > 0}
  <div class="stat-row">
    {#each cells as cell (cell.key)}
      <span class="stat-cell" class:strong={cell.tone === 'strong'} class:warn={cell.tone === 'warn'}
        class:hoverable={!!onHover} title={cell.title} {...over(cell.key)}>
        <span class="stat-v">{cell.value}</span> <span class="stat-l">{cell.label}</span>
      </span>
    {/each}
  </div>
{/if}

<style>
  .stat-row { display: flex; align-items: baseline; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
  .stat-row > * { min-width: 94px; padding: 1px 9px; border-left: 1px solid var(--og-border); }
  .stat-row > :first-child { padding-left: 0; border-left: none; }
  .stat-cell { font-size: 11px; color: var(--og-text-secondary); white-space: nowrap; }
  /* The figure the reader takes away carries the weight; a floor carries the
     warning colour, exactly as the spend headline's own total does. */
  .stat-cell.strong .stat-v { font-size: 12px; font-weight: 600; color: var(--og-text); }
  .stat-cell.warn .stat-v { color: var(--og-warning); }
  .stat-l { text-transform: uppercase; letter-spacing: 0.05em; font-size: 9px; color: var(--og-text-muted); }
  /* A cell that LIGHTS something says so before it is hovered — a cursor, not
     a colour change that would read as state. */
  .stat-cell.hoverable { cursor: default; }
  .stat-cell.hoverable:hover .stat-l, .stat-cell.hoverable:focus-visible .stat-l { color: var(--og-text-secondary); }
</style>
