<script lang="ts">
  // The Labyrinth map SVG — the FRAME only: spine, lane rails, and one
  // LabyrinthNode per step. Every coordinate comes from the pure
  // labyrinthLayout.ts leaf, so the three modes differ in geometry, not in
  // branching here. Colours are theme vars ONLY (this board ships five themes,
  // two of them dark); the cream/ink mockup's palette is deliberately not used.
  import LabyrinthBreaks from './LabyrinthBreaks.svelte';
  import LabyrinthMinimap from './LabyrinthMinimap.svelte';
  import LabyrinthNode from './LabyrinthNode.svelte';
  import LabyrinthRail from './LabyrinthRail.svelte';
  import LabyrinthSwimLane from './LabyrinthSwimLane.svelte';
  import {
    layoutFor, viewBoxFor, LANE_GAP, threadBranchPaths, swimLayout,
    swimLaneCount, swimClockY, THREAD_SPINE_X, FLIGHT_BASE_Y,
    type LayoutStep, type MapMode,
  } from './labyrinthLayout';
  import { flightFrame, NO_FLIGHT_FRAME } from './labyrinthFlightFrame';
  import { branchColumns } from './labyrinthThreadFit';
  import { mapFitStyle } from './labyrinthColumns';

  let {
    steps, mode, selected, onSelect, fade, members = [], fitWidth = 0,
  }: {
    steps: LayoutStep[];
    mode: MapMode;
    selected: number | null;
    onSelect: (step: LayoutStep) => void;
    fade: { steps: ReadonlySet<number>; branches: ReadonlySet<number> }; // what a hovered spend chip fades; both empty = nothing is
    members?: readonly string[]; // collab member slugs, lane order; [] on an ordinary run
    fitWidth?: number; // px to fit the whole map into; 0 = natural size, and the canvas scrolls
  } = $props();

  // Corridor draws its own markers (it needs a per-step RADIUS and its chamber
  // blocks, which the shared point shape does not carry), so it is not laid out
  // here at all — see LabyrinthMinimap.svelte.
  // Flight is called direct, not via layoutFor: only it takes a collab roster.
  let points = $derived(mode === 'corridor' ? [] : mode === 'flight' ? swimLayout(steps, members) : layoutFor(mode, steps));
  // Flight's canvas grows a row per EXTRA swimlane; every other mode ignores it.
  let lanes = $derived(mode === 'flight' ? swimLaneCount(steps, members) : 0);
  let box = $derived(viewBoxFor(mode, steps.length, lanes));
  // Thread only: the rails that make a delegated stretch read as a thread that
  // LEAVES the trunk and comes back, rather than as steps the main agent took.
  let branches = $derived(mode === 'thread' ? threadBranchPaths(steps) : []);
  // Flight only: named rows, per-lane extents, handoff arcs and the three
  // density gates — all of it in one leaf (labyrinthFlightFrame.ts).
  let frame = $derived(mode === 'flight' ? flightFrame(steps, points, members, lanes) : NO_FLIGHT_FRAME);
  // Thread only: how tightly the branch grid is packed, which is what every
  // marker budgets its own labels against (labyrinthThreadFit.ts).
  let columns = $derived(mode === 'thread' ? branchColumns(steps) : 0);
</script>

<!-- xMid, not xMin: with a viewBox narrower than the panel the map would
     otherwise hug the left edge instead of sitting centred in its pane. -->
<svg
  class="lab-svg"
  viewBox="0 0 {box.width} {box.height}"
  preserveAspectRatio="xMidYMin meet"
  style={mapFitStyle(box.width, box.height, fitWidth)}
  role="group"
  aria-label="Run steps"
>
  {#if mode === 'thread'}
    <line class="spine" x1={THREAD_SPINE_X} y1="12" x2={THREAD_SPINE_X} y2={box.height - 16} />
    <line class="rail" x1={THREAD_SPINE_X + LANE_GAP} y1="12" x2={THREAD_SPINE_X + LANE_GAP} y2={box.height - 16} />
    <!-- A branch is drawn as a SPAN: it departs, runs its own steps, TRAILS
         alongside the trunk steps that ran while it was still working, and
         merges where it really returned. No merge is drawn for a sub-agent
         that never came back — that open end is the fact. -->
    {#each branches as b (b.first)}<LabyrinthRail rail={b} dim={fade.branches.has(b.first)} />{/each}
  {:else if mode === 'flight'}
    <line class="spine" x1="16" y1={FLIGHT_BASE_Y} x2={box.width - 16} y2={FLIGHT_BASE_Y} />
    {#each frame.lanes as lane (lane.label)}
      {#if lane.y !== FLIGHT_BASE_Y}
        <line class="rail" x1="16" y1={lane.y} x2={box.width - 16} y2={lane.y} />
      {/if}
      <text class="lane-tag" x="8" y={lane.y - 8}>{lane.label}</text>
    {/each}
    <!-- Each sub-agent departs the main line at its spawn, runs its OWN lane
         for as long as it really ran (genuinely overlapping any sibling that
         ran with it), and rejoins where it reported back — or never does. -->
    {#each frame.spans as s (s.index)}<LabyrinthSwimLane lane={s} dim={fade.branches.has(s.index)} />{/each}{#each frame.edges as e (e.from)}<path class="handoff" d={e.d}><title>handoff to {e.target}</title></path>{/each}
  {/if}
  <LabyrinthBreaks {steps} {mode} {points} {box} /><!-- over the frame, under the markers: a boundary in the picture, never furniture on a step -->
  {#if mode === 'corridor'}
    <LabyrinthMinimap {steps} {selected} {onSelect} dim={fade.steps} />
  {:else}
    {#each points as p, i (p.step.ordinal)}
      <LabyrinthNode
        point={p} {mode} selected={selected === p.step.ordinal} {onSelect} {columns} dim={fade.steps.has(p.step.ordinal)}
        clockY={swimClockY(lanes)} crowded={frame.crowded[i] === true} captionHidden={frame.captionHidden[i] === true} clockHidden={frame.clockHidden[i] === true}
      />
    {/each}
  {/if}
</svg>

<style>
  /* width:100% + min-width lets the map use a wide panel, while a long run
     keeps its natural size and SCROLLS in .lab-canvas instead of squashing
     its labels into an unreadable smear — until fit-to-width is asked for,
     which drops the min-width and scales the HEIGHT by the same factor
     (labyrinthColumns.ts's mapFitStyle). */
  /* margin:auto (not 0 auto) so the pane's flex canvas centres the map on BOTH
     axes — flight is short and was sitting pinned to the top of a tall panel. */
  .lab-svg { display: block; width: 100%; margin: auto; font-family: var(--vscode-editor-font-family, monospace); }
  .spine { stroke: var(--og-border); stroke-width: 1; }
  .rail { stroke: var(--og-border); stroke-width: 1; stroke-dasharray: 3 6; opacity: 0.7; }
  .lane-tag { font-size: 10px; letter-spacing: 0.08em; fill: var(--og-text-muted); }
  .handoff { fill: none; stroke: var(--og-chat); stroke-width: 1.3; stroke-dasharray: 5 3; opacity: 0.8; } /* only where NAMED */
</style>
