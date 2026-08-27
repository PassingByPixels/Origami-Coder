<script lang="ts">
  // The map's CANVAS — the scrolling box the picture sits in, and the one thing
  // that can measure it.
  //
  // Fit-to-width scales the map into the panel rather than scrolling it, so
  // whoever owns the canvas owns the denominator. That used to be the pane,
  // which meant the pane carried a ResizeObserver for a box it only otherwise
  // passed through; the measurement now lives with the element it measures.
  // Extracted from LabyrinthPane.svelte at its architecture cap.
  //
  // 24 below = the canvas's own 12px padding, not drawable width. The observer
  // is guarded as WikiSearchPane.svelte guards its own — jsdom has none, and no
  // layout to fit into, so under test the map never fits.
  //
  // `canvasEl` is BINDABLE because the export reads the rendered SVG out of it
  // (labyrinthExportMap.ts), and only the live DOM has the resolved theme.
  import LabyrinthMap from './LabyrinthMap.svelte';
  import { mapFade, type HighlightTarget } from './labyrinthHighlight';
  import type { LayoutStep, MapMode } from './labyrinthLayout';

  let {
    steps, mode, members, selected, onSelect, fit, canvasEl = $bindable(), highlight = null,
  }: {
    steps: readonly LayoutStep[];
    mode: MapMode;
    members: string[];
    selected: number | null;
    onSelect: (step: LayoutStep) => void;
    fit: boolean;
    canvasEl?: HTMLElement | undefined;
    /** The spend chip the pointer is on; null = nothing is hovered. */
    highlight?: HighlightTarget | null;
  } = $props();

  // What FADES so the hovered chip's own region stands out. Derived here rather
  // than in the pane because it is a property of the DRAWN step list, which is
  // the one thing the canvas already holds — the pane's `steps` and this list
  // part company the moment the thresholds filter is on.
  let fade = $derived(mapFade(steps, highlight));

  let canvasW = $state(0);
  $effect(() => {
    const el = canvasEl;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => (canvasW = el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<div class="lab-canvas" bind:this={canvasEl}>
  <LabyrinthMap {steps} {mode} {members} {selected} {onSelect} {fade} fitWidth={fit ? Math.max(0, canvasW - 24) : 0} />
</div>

<style>
  /* A FLEX canvas so the map's own `margin: auto` centres it on both axes (the
     short flight strip used to sit pinned to the top of a tall panel). Auto
     margins, NOT justify/align-center: centring an overflowing flex item puts
     its leading edge out of scroll reach, and a long thread must stay fully
     scrollable. */
  .lab-canvas { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; display: flex; }
</style>
