<script lang="ts">
  // ONE sub-agent's swimlane on the flight strip: the departure off the line it
  // was spawned from, the bar covering the wall-clock stretch it really ran
  // for, and the rejoin where it reported back. A run that never came back has
  // no rejoin — its lane reaches the right-hand edge and stops on an open ring,
  // which is the fact, not an omission.
  //
  // Geometry is entirely labyrinthSwim.ts's; this is markup and tone only.
  // Colours are theme vars ONLY — this board ships five themes, two of them dark.
  import type { FlightSpan } from './labyrinthLayout';

  // `dim`: a spend chip is hovered and this lane is not what it names.
  let { lane, dim = false }: { lane: FlightSpan; dim?: boolean } = $props();
</script>

<!-- `background` is tri-state: an unclassed lane is one the engine said nothing
     about, and must look like neither detached nor blocking. -->
<g
  class="swim-lane"
  class:is-open={lane.open}
  class:is-bg={lane.background === true}
  class:is-fg={lane.background === false}
  class:is-dim={dim}
>
  <path class="swim-depart" d={lane.depart} />
  <line class="flight-span" class:is-open={lane.open} x1={lane.x1} y1={lane.y} x2={lane.x2} y2={lane.y} />
  {#if lane.rejoin}
    <path class="swim-rejoin" d={lane.rejoin} />
  {:else}
    <circle class="swim-open-end" cx={lane.x2} cy={lane.y} r="3.5" />
  {/if}
</g>

<style>
  .swim-lane { fill: none; }
  /* The wall-clock extent of a sub-agent, along its own lane. */
  .flight-span { stroke: var(--og-accent-2); stroke-width: 3; opacity: 0.45; stroke-linecap: round; }
  .swim-depart, .swim-rejoin { stroke: var(--og-accent-2); stroke-width: 1.3; stroke-dasharray: 4 3; opacity: 0.75; }
  /* Detached vs blocking, only where the engine SAID which. */
  .swim-lane.is-bg .flight-span { stroke-dasharray: 7 4; }
  .swim-lane.is-fg .flight-span { opacity: 0.7; }
  /* Never came back: full-strength, stopped by an open ring rather than a
     rejoin, so it cannot be mistaken for a lane that closed. */
  .flight-span.is-open { stroke: var(--og-warning); stroke-dasharray: 6 4; opacity: 1; }
  .swim-lane.is-open .swim-depart { stroke: var(--og-warning); opacity: 1; }
  .swim-open-end { fill: var(--og-surface); stroke: var(--og-warning); stroke-width: 1.6; }
  /* Last, so a hovered chip fades even the full-strength open and foreground lanes. */
  .swim-lane.is-dim { opacity: 0.14; }
</style>
