<script lang="ts">
  // Every caption in the picture, drawn LAST so nothing stands in front of it:
  // the street and district headings, the section captions inside a district, and
  // the component names.
  //
  // Split from the plates and the solids they name because SVG paints in document
  // order — a heading emitted beside its plate would sit under the first tall box
  // standing on it. Separating the layers is the only fix; z-index does not exist
  // in SVG.
  //
  // The zone HEADINGS are composed here, not carried in the geometry: the layout
  // ships a flow index and a pillar number, and each renderer looks the names up
  // in its own copy — which is what keeps the pillar mirror load-bearing and its
  // drift guard honest.
  import type { IsoLayout } from '../../../src/dashboard/agentManager/isoLayout';
  import type { MapFlow } from '../../../src/dashboard/agentManager/mapSchema';
  import { flowColour, pillarColour } from './repoMapPalette';
  import { PILLARS } from './repoMapPillars';
  import { showsName, type LabelMode } from './repoMapFilters';

  let {
    layout, flows, hideIds, labelMode, zoom,
  }: {
    layout: IsoLayout;
    flows: readonly MapFlow[];
    hideIds: ReadonlySet<string>;
    labelMode: LabelMode;
    zoom: number;
  } = $props();

  const pillarName = (n: number): string => PILLARS.find((p) => p.number === n)?.name ?? `Pillar ${n}`;
  const street = (kind: string): boolean => kind === 'street';
  const heading = (kind: string, flow: number, pillar: number): string =>
    (street(kind) ? `FLOW ${flow + 1} · ${flows[flow]?.name ?? ''}` : `${pillar} · ${pillarName(pillar)}`);
  const sub = (kind: string, flow: number, count: number): string =>
    (street(kind)
      ? `${flows[flow]?.steps.length ?? 0} steps · ${count} components live here`
      : `${count} off-flow components`);
  const tint = (kind: string, flow: number, pillar: number): string =>
    (street(kind) ? flowColour(flow) : pillarColour(pillar));
  const short = (s: string): string => (s.length > 22 ? `${s.slice(0, 21)}…` : s);
</script>

<g class="labels">
  {#each layout.zones as z, i (i)}
    <text class="zlab" x={z.label.x} y={z.label.y} text-anchor={z.anchor}
      fill="color-mix(in srgb, {tint(z.kind, z.flow, z.pillar)} 65%, white)">{heading(z.kind, z.flow, z.pillar)}</text>
    <text class="zsub" x={z.label.x} y={z.label.y + 12} text-anchor={z.anchor}>{sub(z.kind, z.flow, z.count)}</text>
  {/each}
  {#each layout.sectionLabels as s, i (i)}
    <text class="slab" x={s.at.x} y={s.at.y}>{s.section} ({s.count})</text>
  {/each}
  {#each layout.boxes as b (b.id)}
    {#if !hideIds.has(b.id) && showsName(labelMode, zoom, b.degree + b.flows)}
      <text class="caption" x={b.foot.x} y={b.foot.y}>{short(b.name)}</text>
    {/if}
  {/each}
</g>

<style>
  /* paint-order: stroke gives every label its own halo in the ground colour, so
     it stays readable over a solid instead of needing a plate behind it. */
  text { paint-order: stroke; stroke: var(--og-bg); stroke-linejoin: round; pointer-events: none; }
  .zlab { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; stroke-width: 3px; }
  .zsub { font-size: 9px; fill: var(--og-text-muted); stroke-width: 2.6px; }
  .slab { font-size: 9px; font-weight: 600; fill: var(--og-text-muted); letter-spacing: 0.04em;
    text-anchor: middle; stroke-width: 2.6px; }
  .caption { font-size: 8.5px; fill: var(--og-text); text-anchor: middle; stroke-width: 2.6px; }
</style>
