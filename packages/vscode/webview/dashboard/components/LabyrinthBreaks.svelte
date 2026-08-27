<script lang="ts">
  // WHERE THE RUN CHANGED MODEL, drawn on whichever layout is on screen.
  //
  // Thread and Flight both have a straight axis the run travels along — y for
  // one, time for the other — so the break is a RULE across the picture at the
  // point the new model starts, labelled with its short id. Everything past the
  // rule is the new model's work, and that reading is exactly true.
  //
  // CORRIDOR IS DELIBERATELY DIFFERENT, and the difference is honest rather
  // than a shortfall. A boustrophedon snake spends both axes on sequence and
  // reverses direction every row, so there is no line across the canvas that
  // means "after this point": the same rule would cut the run in two places on
  // one row and in none on the next. The break is therefore a TICK on the cell
  // the new model starts in, set against the side the corridor entered that
  // cell from, so it still reads as a boundary rather than as a marker. Both
  // model ids stay on the hover title in every layout, because a short label
  // names only the incoming half.
  //
  // WHICH steps count is labyrinthBreaks.ts's rule (trunk only, models actually
  // recorded); this file is geometry and tone. Extracted rather than grown into
  // LabyrinthMap.svelte, which had three lines under its cap. Theme vars ONLY.
  import { minimapLayout } from './labyrinthMinimap';
  import { modelBreaks } from './labyrinthBreaks';
  import { THREAD_ROW, type LayoutPoint, type LayoutStep, type MapMode } from './labyrinthLayout';

  let { steps, mode, points, box }: {
    steps: readonly LayoutStep[];
    mode: MapMode;
    /** Thread's and Flight's markers. Corridor's are empty — see `cells`. */
    points: readonly LayoutPoint[];
    box: { width: number; height: number };
  } = $props();

  /** A corridor break has no point in `points`: the minimap draws its own
   *  markers, so its layout is recomputed here — pure and O(n), exactly as
   *  LabyrinthMinimap.svelte recomputes it beside this. */
  let cells = $derived(mode === 'corridor' ? minimapLayout(steps) : null);
  let at = $derived<readonly { x: number; y: number }[]>(cells ? cells.points : points);
  let breaks = $derived(modelBreaks(steps));

  /** One break as the geometry its layout can actually carry. */
  interface Mark { key: number; label: string; d: string; tx: number; ty: number; title: string }

  let marks = $derived(
    breaks.flatMap((b): Mark[] => {
      const p = at[b.index];
      if (!p) return [];
      const title = `model changed: ${b.from} -> ${b.to}`;
      if (mode === 'thread') {
        // Half a row above the marker: the rule sits BETWEEN the last step on
        // the old model and the first on the new one, not through either.
        const y = p.y - THREAD_ROW / 2;
        return [{ key: b.index, label: b.label, d: `M 10 ${y} L ${box.width - 10} ${y}`, tx: 14, ty: y - 4, title }];
      }
      if (mode === 'flight') {
        const x = p.x - 7;
        return [{ key: b.index, label: b.label, d: `M ${x} 16 L ${x} ${box.height - 8}`, tx: x + 3, ty: 12, title }];
      }
      const pitch = Math.min(cells!.cellW, cells!.rowH);
      // The side the corridor came IN from, so the tick reads as a boundary the
      // run crossed rather than as decoration on the marker.
      const before = at[b.index - 1] ?? p;
      const x = p.x - (p.x >= before.x ? 1 : -1) * cells!.cellW * 0.4;
      // No label where the cells are too small to carry one: at 336 steps it
      // would be a smear, and the tick plus its title still say what happened.
      return [{ key: b.index, label: cells!.cellW >= 30 ? b.label : '', d: `M ${x} ${p.y - pitch * 0.45} L ${x} ${p.y + pitch * 0.45}`, tx: x + 3, ty: p.y - pitch * 0.5, title }];
    }),
  );
</script>

{#each marks as m (m.key)}
  <g class="lab-break">
    <path class="break-rule" d={m.d}><title>{m.title}</title></path>
    {#if m.label}<text class="break-tag" x={m.tx} y={m.ty}>{m.label}</text>{/if}
  </g>
{/each}

<style>
  /* Muted and dashed: a break is a fact about the run, never a failure, and it
     must not compete with the threshold bars or the branch rails it crosses. */
  .break-rule { fill: none; stroke: var(--og-text-muted); stroke-width: 1; stroke-dasharray: 2 4; opacity: 0.8; }
  .break-tag { font-size: 9px; letter-spacing: 0.06em; fill: var(--og-text-muted); }
</style>
