<script lang="ts">
  // One 24x24 glyph per step kind, in the mockup's idiom (hermes-labyrinth
  // src/parts/20-glyphs.js): fill=none, stroke=currentColor, round caps and
  // joins. `currentColor` is the point — the parent <g> sets `color` once from
  // the step's tone and both its marker and this glyph follow, so a kind's
  // shape and its colour can never drift apart.
  //
  // Circles are written as arc paths so the whole glyph is one uniform loop.
  import type { LayoutStep } from './labyrinthLayout';

  let {
    kind, x, y, size = 18,
  }: { kind: LayoutStep['kind']; x: number; y: number; size?: number } = $props();

  const DOT = (cx: number, cy: number, r: number) =>
    `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;

  // prompt: an arrow arriving at the run. reply: one leaving it.
  // tool: the mockup's tool_call. thinking: its compression stack, read as
  // internal work. subagent: its subagent_spawn fan-out. error: a warned mark.
  const PATHS: Record<string, string[]> = {
    prompt: ['M3 12h11', 'M10 8l4 4-4 4', DOT(19, 12, 1.4)],
    reply: [DOT(5, 12, 1.4), 'M9 12h11', 'M16 8l4 4-4 4'],
    tool: ['M5 5l5 5', 'M5 12l5-2', 'M5 19l5-5', DOT(15, 12, 3.2)],
    thinking: ['M4 7h16', 'M6.5 12h11', 'M9 17h6'],
    subagent: [DOT(6, 6, 1.6), 'M6 7.6V12', 'M6 12c0 4 4 4 8 4', 'M6 12c0-3 4-3 8-3', DOT(18, 16, 1.6), DOT(18, 9, 1.6)],
    error: ['M12 3.5L1.8 20.5h20.4z', 'M12 9.5v4.5', 'M11.99 17.4h.02'],
  };

  let paths = $derived(PATHS[kind] ?? [DOT(12, 12, 6)]);
</script>

<svg
  data-glyph={kind}
  {x}
  {y}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each paths as d (d)}<path {d} />{/each}
</svg>
