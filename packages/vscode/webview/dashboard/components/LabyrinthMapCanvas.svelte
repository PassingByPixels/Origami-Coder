<script lang="ts">
  // The map's CANVAS — the box the picture sits in, and the one thing that can
  // measure it.
  //
  // Whoever owns the canvas owns the denominator, which is why the measurement
  // lives with the element it measures rather than in the pane. Thread and
  // corridor spend that width on fit-to-width scaling; the analytics FLIGHT view
  // spends it on building its chart at exactly that width, which is what makes
  // its default render 1:1 and crisp instead of a big canvas squashed down.
  // Extracted from LabyrinthPane.svelte at its architecture cap.
  //
  // 24 below = the canvas's own 12px padding, not drawable width. The measuring
  // itself is labyrinthMeasure.ts's — jsdom has no observer and no layout, so
  // under test the width stays 0 and the map never fits.
  //
  // `canvasEl` is BINDABLE because the export reads the rendered SVG out of it
  // (labyrinthExportMap.ts), and only the live DOM has the resolved theme.
  //
  // A COLLAB map keeps the older swimlane strip on purpose: its `members` are
  // parallel ROOT sessions that nobody delegated to, so it has no main agent and
  // no sub-agent band — the two things the analytics layout is built around.
  import LabyrinthFlightView from './LabyrinthFlightView.svelte';
  import LabyrinthMap from './LabyrinthMap.svelte';
  import { mapFade, type HighlightTarget } from './labyrinthHighlight';
  import { observeWidth } from './labyrinthMeasure';
  import type { LayoutStep, MapMode } from './labyrinthLayout';

  let {
    steps, mode, members, selected, onSelect, fit, canvasEl = $bindable(), highlight = null, onHighlight, claudeRun = false,
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
    /** Set when the FLIGHT view's own pills and bars point at the chart. */
    onHighlight?: (target: HighlightTarget | null) => void;
    claudeRun?: boolean; // a Claude Code transcript — passed through to FLIGHT's cache panel
  } = $props();

  // What FADES so the hovered chip's own region stands out. Derived here rather
  // than in the pane because it is a property of the DRAWN step list, which is
  // the one thing the canvas already holds — the pane's `steps` and this list
  // part company the moment the thresholds filter is on.
  let fade = $derived(mapFade(steps, highlight));
  let analytics = $derived(mode === 'flight' && members.length === 0);

  let canvasW = $state(0);
  $effect(() => observeWidth(canvasEl, (px) => (canvasW = px)));
</script>

<div class="lab-canvas" class:analytics bind:this={canvasEl}>
  {#if analytics}
    <LabyrinthFlightView {steps} {selected} {onSelect} {onHighlight} {claudeRun} dim={fade.steps} dimLanes={fade.branches} width={Math.max(0, canvasW - 24)} />
  {:else}
    <LabyrinthMap {steps} {mode} {members} {selected} {onSelect} {fade} fitWidth={fit ? Math.max(0, canvasW - 24) : 0} />
  {/if}
</div>

<style>
  /* A FLEX canvas so the map's own `margin: auto` centres it on both axes (the
     short flight strip used to sit pinned to the top of a tall panel). Auto
     margins, NOT justify/align-center: centring an overflowing flex item puts
     its leading edge out of scroll reach, and a long thread must stay fully
     scrollable. */
  .lab-canvas { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; display: flex; }
  /* The analytics view is a PAGE, not a picture: it owns its own scrolling and
     its own padding, so the canvas gives it the whole box and gets out of the way. */
  .lab-canvas.analytics { overflow: hidden; padding: 0; }
</style>
