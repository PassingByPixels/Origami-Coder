<script lang="ts">
  // ONE branch rail: the four segments a delegated run is drawn from, plus the
  // open terminus when it never returned. Split out of LabyrinthMap.svelte (at
  // its architecture cap) when a branch stopped being "depart, spine, merge"
  // and became a SPAN that can outlive its own last step.
  //
  // Geometry is entirely labyrinthRails.ts's; this is markup and tone only.
  // Colours are theme vars ONLY — this board ships five themes, two of them dark.
  import type { BranchPath } from './labyrinthLayout';

  // `dim`: a spend chip is hovered and this branch is not what it names.
  let { rail, dim = false }: { rail: BranchPath; dim?: boolean } = $props();
</script>

<!-- No merge is drawn for a sub-agent that never came back: the open end IS
     the information. `background` is tri-state — an unclassed rail is one the
     engine said nothing about, and must look like neither detached nor blocking. -->
<g
  class="branch-rail"
  class:is-open={rail.open}
  class:is-bg={rail.background === true}
  class:is-fg={rail.background === false}
  class:is-dim={dim}
>
  <path class="branch-depart" d={rail.depart} />
  {#if rail.spine}<path class="branch-spine" d={rail.spine} />{/if}
  {#if rail.trail}<path class="branch-trail" d={rail.trail} />{/if}
  {#if rail.merge}<path class="branch-merge" d={rail.merge} />{/if}
  {#if rail.open}<circle class="branch-open-end" cx={rail.x} cy={rail.endY} r="3.5" />{/if}
</g>

<style>
  .branch-rail { fill: none; stroke: var(--og-accent-2); stroke-width: 1.3; opacity: 0.75; }
  .branch-spine { stroke-width: 1.6; }
  .branch-depart, .branch-merge { stroke-dasharray: 4 3; }
  /* The in-flight stretch is drawn LIGHTER than the branch's own steps: the
     sub-agent was working here, but no step of it is on screen at this height. */
  .branch-trail { stroke-width: 1.3; stroke-dasharray: 2 5; }
  /* Detached vs blocking, only where the engine SAID which. */
  .branch-rail.is-bg .branch-spine { stroke-dasharray: 7 4; }
  .branch-rail.is-fg { opacity: 1; }
  .branch-rail.is-fg .branch-spine { stroke-width: 2.4; }
  /* Never came back: full-strength, and stopped by an open ring rather than a
     merge, so it cannot be mistaken for a branch that returned. */
  .branch-rail.is-open { stroke: var(--og-warning); opacity: 1; }
  .branch-open-end { fill: var(--og-surface); stroke: var(--og-warning); stroke-width: 1.6; }
  /* Last, so a hovered chip fades even the full-strength open and foreground rails. */
  .branch-rail.is-dim { opacity: 0.14; }
</style>
