<script lang="ts">
  // The SOLIDS: one extruded box per component (a stack of plates for pillar 5,
  // Artifacts & Outputs), in the painter's order the layout sorted them into.
  //
  // COLOUR IS THE DATA. A box's hue is its `kind`, from the mirrored palette, and
  // the three faces are three tones of that one hue — mixed in CSS toward black,
  // which is the same arithmetic the host renderer applies for the exported
  // artifact (shade(c, 0.5) IS color-mix(in srgb, c 50%, black) in sRGB). So the
  // two surfaces show the same colours without mirroring a shading function.
  //
  // Everything else is theme chrome and stays in --og-* tokens.
  import type { IsoBox, IsoLayout } from '../../../src/dashboard/agentManager/isoLayout';
  import { kindColour } from './repoMapPalette';
  import { pointsAttr } from './isoView';

  let {
    layout, selected, dimIds, hideIds, onPick, onHover, onLeave,
  }: {
    layout: IsoLayout;
    selected: string;
    /** Faded because something else is selected or a flow is traced. */
    dimIds: ReadonlySet<string>;
    /** Removed outright by the search or a kind/pillar toggle. */
    hideIds: ReadonlySet<string>;
    onPick: (id: string) => void;
    onHover: (b: IsoBox) => void;
    onLeave: () => void;
  } = $props();
</script>

<g class="nodes">
  {#each layout.boxes as b (b.id)}
    {#if !hideIds.has(b.id)}
      <g class="node" class:sel={b.id === selected} class:dim={dimIds.has(b.id)}
        style="--k: {kindColour(b.kind)}"
        role="button" tabindex="0" aria-label={b.name}
        onclick={() => onPick(b.id)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(b.id); } }}
        onmouseenter={() => onHover(b)} onmouseleave={onLeave}
        onfocus={() => onHover(b)} onblur={onLeave}>
        {#each b.plates as f, i (i)}
          <polygon class="f-left" points={pointsAttr(f.left)} />
          <polygon class="f-right" points={pointsAttr(f.right)} />
          <polygon class="f-top" points={pointsAttr(f.top)} />
        {/each}
        <text class="badge" x={b.centre.x} y={b.centre.y + 1}>{b.code}</text>
        <title>{b.path ? `${b.name} — ${b.path}` : b.name}</title>
      </g>
    {/if}
  {/each}
</g>

<style>
  .node { cursor: pointer; }
  .node polygon { stroke-linejoin: round; stroke-width: 0.7; }
  .node .f-top { fill: var(--k); stroke: color-mix(in srgb, var(--k) 65%, white); stroke-width: 0.8; }
  .node .f-right { fill: color-mix(in srgb, var(--k) 74%, black); stroke: color-mix(in srgb, var(--k) 42%, black); }
  .node .f-left { fill: color-mix(in srgb, var(--k) 50%, black); stroke: color-mix(in srgb, var(--k) 32%, black); }
  .node .badge { fill: var(--og-bg); font-size: 9px; font-weight: 700; text-anchor: middle;
    dominant-baseline: middle; pointer-events: none; letter-spacing: 0.03em; }
  .node.sel .f-top { stroke: var(--og-text); stroke-width: 1.6; }
  .node:focus-visible .f-top { stroke: var(--og-accent); stroke-width: 1.6; }
  .node.dim { opacity: 0.13; }
</style>
