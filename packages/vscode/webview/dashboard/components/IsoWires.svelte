<script lang="ts">
  // What JOINS the solids: every static dependency as a bowed arrow, the selected
  // component's edges lit and labelled, and the traced flow as a coloured path
  // with a numbered badge on each step.
  //
  // NO GEOMETRY IS COMPUTED HERE either. The curve, its control point, the three
  // corners of the arrowhead and the badge positions all arrive from
  // isoWires.ts on the host, so this component and the exported artifact draw
  // the same lines. All this file decides is which of them are on.
  import type { IsoLayout } from '../../../src/dashboard/agentManager/isoLayout';
  import type { IsoFlowSeg, IsoLink } from '../../../src/dashboard/agentManager/isoWires';
  import { flowColour } from './repoMapPalette';
  import { pointsAttr } from './isoView';

  let {
    layout, selected, flowId, showEdges,
  }: {
    layout: IsoLayout;
    selected: string;
    flowId: string;
    showEdges: boolean;
  } = $props();

  /** A quadratic through one control point — the one place the curve is spelt as
   *  a path on this side of the seam. */
  const quad = (s: { x: number; y: number }, c: { x: number; y: number }, e: { x: number; y: number }): string =>
    `M ${s.x} ${s.y} Q ${c.x} ${c.y} ${e.x} ${e.y}`;
  const segPath = (s: IsoFlowSeg): string => quad(s.a, s.c, s.b);
  const hot = (l: IsoLink): boolean => selected !== '' && (l.from === selected || l.to === selected);
  const short = (s: string): string => (s.length > 34 ? `${s.slice(0, 33)}…` : s);
</script>

{#if showEdges}
  <g class="links">
    {#each layout.links as l, i (i)}
      <g class="lk" class:hot={hot(l)} class:dim={(selected !== '' && !hot(l)) || flowId !== ''}>
        <path class="link" d={quad(l.s, l.c, l.e)} />
        <polygon class="tip" points={pointsAttr(l.head)} />
      </g>
    {/each}
  </g>
{/if}

<g class="traces">
  {#each layout.flowPaths as f (f.id)}
    {#if f.id === flowId}
      {#each f.segs as s, i (i)}
        <path class="flowline" d={segPath(s)} stroke={flowColour(f.index)} />
      {/each}
      {#each f.marks as m (m.n)}
        <circle class="markdot" cx={m.at.x} cy={m.at.y} r="9" fill={flowColour(f.index)} />
        <text class="markn" x={m.at.x} y={m.at.y + 1}>{m.n}</text>
      {/each}
    {/if}
  {/each}
</g>

<g class="elabs">
  {#each layout.links as l, i (i)}
    {#if hot(l) && l.label}
      <text class="elab" x={l.mid.x} y={l.mid.y - 4}>{short(l.label)}</text>
    {/if}
  {/each}
</g>

<style>
  .link { fill: none; stroke: var(--og-text-muted); stroke-width: 1.3; opacity: 0.48; }
  .tip { fill: var(--og-text-muted); opacity: 0.55; }
  .lk.hot .link { stroke: var(--og-accent); stroke-width: 2.4; opacity: 1; }
  .lk.hot .tip { fill: var(--og-accent); opacity: 1; }
  .lk.dim { opacity: 0.13; }
  .flowline { fill: none; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; opacity: 0.95; }
  .markdot { stroke: var(--og-bg); stroke-width: 1.5; }
  .markn { fill: var(--og-bg); font-size: 9px; font-weight: 700; text-anchor: middle;
    dominant-baseline: middle; pointer-events: none; }
  /* paint-order: stroke draws the halo FIRST and the fill over it, so a label
     stays readable over a solid without a plate behind it. */
  .elab { fill: var(--og-accent); font-size: 8.5px; font-weight: 600; text-anchor: middle; pointer-events: none;
    paint-order: stroke; stroke: var(--og-bg); stroke-width: 2.6px; stroke-linejoin: round; }
</style>
