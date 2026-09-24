<script lang="ts">
  // THE TICKS THEMSELVES — one shape per drawn mark, on whichever band
  // labyrinthChart.ts put it.
  //
  // Extracted from LabyrinthFlightChart.svelte at its architecture cap, the same
  // seam LabyrinthFlightBand.svelte took before it. It is also the right split on
  // its own terms: the parent is now the chart's FRAME and its interaction
  // surface, and this is the one part of the picture that is per-STEP and
  // clickable. A tick's click is the reference selection path — the time cursor
  // in the parent snaps onto these same marks and ends in the same call.
  //
  // Every coordinate is labyrinthChart.ts's; the fills arrive as `var(--og-*)`
  // strings from labyrinthCategory.ts / labyrinthTone.ts. Nothing is decided
  // here, and there is no palette in this file to drift from theirs.
  import type { FlightChart, ChartMark } from './labyrinthChart';

  let { chart, selected, onSelect, dim }: {
    chart: FlightChart;
    /** Ordinal of the picked step; null = nothing picked. */
    selected: number | null;
    onSelect: (ordinal: number) => void;
    /** Ordinals to FADE — what a hovered pill or category bar is NOT about. */
    dim: ReadonlySet<number>;
  } = $props();

  const diamondPath = (m: ChartMark): string => {
    const r = m.w / 2;
    return `M ${m.x} ${m.y - r} L ${m.x + r} ${m.y} L ${m.x} ${m.y + r} L ${m.x - r} ${m.y} Z`;
  };
</script>

{#each chart.marks as m, i (`${m.band}-${m.ordinal}-${i}`)}
  {#if m.diamond}
    <path class="fl-mark" class:selected={selected === m.ordinal} class:dim={dim.has(m.ordinal)}
      data-ordinal={m.ordinal} data-band={m.band} d={diamondPath(m)} fill={m.fill}
      role="button" tabindex="-1" onclick={() => onSelect(m.ordinal)} onkeydown={() => {}} />
  {:else}
    <rect class="fl-mark" class:selected={selected === m.ordinal} class:dim={dim.has(m.ordinal)}
      data-ordinal={m.ordinal} data-band={m.band} x={m.x} y={m.y} width={m.w} height={m.h} fill={m.fill} rx="0.8"
      role="button" tabindex="-1" onclick={() => onSelect(m.ordinal)} onkeydown={() => {}} />
  {/if}
{/each}

<style>
  .fl-mark { cursor: pointer; }
  .fl-mark:hover { filter: brightness(1.3); }
  .fl-mark.selected { stroke: var(--og-text); stroke-width: 1.2; }
  /* What a hovered pill or bar is NOT about. Fading the rest, rather than
     lighting the match, keeps "nothing hovered" identical to the plain chart. */
  .fl-mark.dim { opacity: 0.15; }
</style>
