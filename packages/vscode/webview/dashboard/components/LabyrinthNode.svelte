<script lang="ts">
  // ONE marker on the map: its lane connector back to the spine, its threshold
  // bar, the circle, the kind glyph and the mode's labels. Split out of
  // LabyrinthMap.svelte (which is at its architecture cap) when lanes, glyphs
  // and thresholds landed — the map is now the frame, this is the furniture.
  // Flight's own labels went on to LabyrinthFlightLabels.svelte when THREAD's
  // furniture had to start budgeting itself against the column pitch.
  // Colours are theme vars ONLY; the tone class sets `color` and both the
  // circle's stroke and the glyph's `currentColor` inherit it.
  import LabyrinthGlyph from './LabyrinthGlyph.svelte';
  import LabyrinthFlightLabels from './LabyrinthFlightLabels.svelte';
  import {
    stepGlyph, isThreshold, formatDuration, threadLabel, LANE_GAP,
    THREAD_SPINE_X, THREAD_META_DX, THREAD_LABEL_X, THREAD_LABEL_CHARS, FLIGHT_BASE_Y,
    type LayoutPoint, type MapMode,
  } from './labyrinthLayout';
  import { columnPitch, metaFits, threshHalf, glyphSize, captionChars } from './labyrinthThreadFit';

  // `clockY` follows the lowest swimlane; `crowded` / `captionHidden` / `clockHidden` gate the detail rows, the caption and the TIME-AXIS label when a neighbour is too close to print beside (labyrinthSwim.ts, labyrinthCaptions.ts — the clock row is ONE line whatever the lane, so it collides where a caption does not). All four are flight's, and are forwarded untouched.
  let {
    point, mode, selected, onSelect, columns = 0, clockY, crowded = false, captionHidden = false, clockHidden = false, dim = false,
  }: {
    point: LayoutPoint;
    mode: MapMode;
    selected: boolean;
    dim?: boolean; // a spend chip is hovered and this step is not part of what it names
    onSelect: (step: LayoutPoint['step']) => void;
    columns?: number; // branch columns in use, thread only — one crowds nothing
    clockY?: number;
    crowded?: boolean;
    captionHidden?: boolean;
    clockHidden?: boolean;
  } = $props();

  let step = $derived(point.step);
  let threshold = $derived(isThreshold(step));
  // The connector that makes an off-spine marker read as a branch off the main
  // line rather than a stray dot — the mockup draws exactly this (30-map.js:64).
  // A DELEGATED step needs none: it sits on its branch's own rail, which the
  // map frame draws through it from departure to merge.
  let branch = $derived(
    mode === 'thread' && point.x > THREAD_SPINE_X
      ? `M ${THREAD_SPINE_X} ${point.y} L ${point.x} ${point.y}`
      : mode === 'flight' && point.y !== FLIGHT_BASE_Y
        ? `M ${point.x} ${FLIGHT_BASE_Y} L ${point.x} ${point.y}`
        : null,
  );
  // Corridor never mounts this component — the minimap draws its own markers.
  // Every piece of furniture below was sized for the SPINE, whose neighbour is
  // a whole LANE_GAP away; a branch column's is BRANCH_COL_GAP. So the budget
  // comes from the pitch AT THIS POINT (labyrinthThreadFit.ts). Flight places
  // by clock, not by column, and keeps the spine's roomier budget.
  let pitch = $derived(mode === 'thread' ? columnPitch(point.x, THREAD_SPINE_X, columns) : LANE_GAP);
  let dur = $derived(formatDuration(step.durationMs));
  let meta = $derived(`${step.ordinal}${dur ? ` · ${dur}` : ''}`);
  // Too narrow to print the meta beside the marker: it moves to the FRONT of
  // the caption, which has ~440 unused units, rather than being dropped —
  // nothing is lost, and the label's own budget pays for the prefix.
  let metaBeside = $derived(metaFits(pitch));
  let caption = $derived(threadLabel(step, metaBeside ? THREAD_LABEL_CHARS : captionChars(THREAD_LABEL_CHARS, meta)));
</script>

<g
  class="node tone-{stepGlyph(step)}"
  class:is-selected={selected}
  class:is-threshold={threshold} class:is-collab={step.collabTool === true} class:is-baton={step.baton === true} class:is-dim={dim}
  role="button"
  tabindex="0"
  aria-label={step.title}
  data-ordinal={step.ordinal}
  onclick={() => onSelect(step)}
  onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(step); } }}
>
  <!-- Labels are truncated to their column; the full text stays reachable on hover. -->
  <title>{step.tool ? `${step.kind}: ${step.tool} — ` : ''}{step.title}</title>
  {#if branch}<path class="branch" d={branch} />{/if}
  {#if threshold}<line class="thresh" x1={point.x - threshHalf(pitch)} y1={point.y} x2={point.x + threshHalf(pitch)} y2={point.y} />{/if}
  <circle class="hit" cx={point.x} cy={point.y} r="15" />
  <circle
    class="marker"
    cx={point.x}
    cy={point.y}
    r={selected ? 9 : 5.5}
    fill={selected ? 'var(--og-text)' : 'var(--og-surface)'}
  />
  <!-- Squeezed, never clipped, where the neighbouring column is close: a clip
       would hide the overrun silently instead of resolving it. -->
  <LabyrinthGlyph kind={step.kind} x={point.x + 12} y={point.y - 9} size={glyphSize(pitch)} />

  {#if mode === 'flight'}
    <LabyrinthFlightLabels {step} x={point.x} y={point.y} {selected} {clockY} {crowded} {captionHidden} {clockHidden} />
  {:else}
    <text class="meta" x={point.x + THREAD_META_DX} y={point.y + 4}>{metaBeside ? meta : ''}</text>
    <text class="caption" x={THREAD_LABEL_X} y={point.y + 4}>{metaBeside ? '' : `${meta} · `}{caption}</text>
  {/if}
</g>

<style>
  .node { cursor: pointer; outline: none; color: var(--og-text-secondary); }
  .tone-prompt { color: var(--og-chat); }
  .tone-reply { color: var(--og-text); }
  .tone-thinking { color: var(--og-text-muted); }
  .tone-tool { color: var(--og-success); }
  .tone-subagent { color: var(--og-accent-2); }
  .tone-error { color: var(--og-error); }
  .hit { fill: transparent; }
  /* Flock call = not ordinary work; a `[Collab:]` baton is the runner, not a person, so it DIMS. */
  .node.is-collab { color: var(--og-accent-2); } .node.is-baton { opacity: 0.55; } .node.is-dim { opacity: 0.14; } /* a hovered spend chip fades what it is NOT about; last, so it beats the baton fade */
  .branch { fill: none; stroke: currentColor; stroke-width: 1.2; opacity: 0.6; }
  .node.is-selected .branch { opacity: 1; }
  /* Mockup threshold rule (30-map.js:71) - a boundary is marked even with the filter off. */
  .thresh { stroke: var(--og-warning); stroke-width: 1.4; }
  .marker { stroke: currentColor; stroke-width: 1.6; }
  .node:hover .marker { stroke-width: 2.4; }
  .node:focus-visible .marker { stroke-width: 2.4; }
  .caption { font-size: 13px; fill: var(--og-text-secondary); }
  .node.is-selected .caption { fill: var(--og-text); font-weight: 600; }
  .meta { font-size: 11px; fill: var(--og-text-muted); font-variant-numeric: tabular-nums; }
</style>
