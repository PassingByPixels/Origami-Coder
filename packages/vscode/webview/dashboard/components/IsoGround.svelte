<script lang="ts">
  // The map's GROUND: one plate per flow street and one per docked pillar
  // district. Painted first, under everything.
  //
  // The plates are separated from their CAPTIONS (IsoLabels.svelte) because SVG
  // paints in document order and a caption has to sit above the boxes standing on
  // the plate it names — so the two cannot be one component without the label
  // disappearing under the first tall solid.
  //
  // NO GEOMETRY IS COMPUTED HERE. Every polygon arrives already projected in the
  // tab payload (isoLayout.ts, host side), and the zones arrive sorted by depth.
  import type { IsoLayout } from '../../../src/dashboard/agentManager/isoLayout';
  import { flowColour, pillarColour } from './repoMapPalette';
  import { pointsAttr } from './isoView';

  let { layout }: { layout: IsoLayout } = $props();

  const tint = (kind: string, flow: number, pillar: number): string =>
    (kind === 'street' ? flowColour(flow) : pillarColour(pillar));
</script>

<g class="ground">
  {#each layout.zones as z, i (i)}
    <polygon class="zone" class:district={z.kind === 'district'}
      points={pointsAttr(z.poly)} style="--tint: {tint(z.kind, z.flow, z.pillar)}" />
  {/each}
</g>

<style>
  /* A street is a solid road plate, a district a dashed dock — the same two
     languages the mockup used, so the eye separates "what runs" from "what is
     merely here". The fills are colour-mixes of the zone's own tint toward black,
     which is exactly what the host renderer's shade() computes for the artifact. */
  .zone { fill: color-mix(in srgb, var(--tint) 20%, black); stroke: color-mix(in srgb, var(--tint) 80%, black); stroke-width: 1.2; }
  .zone.district { stroke-dasharray: 6 5; }
</style>
