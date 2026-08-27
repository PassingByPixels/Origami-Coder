<script lang="ts">
  // Corridor's markup — markers over the pure minimapLayout points, plus the
  // chamber rectangles and the corridor line through the main thread. NO
  // captions: at a 336-step density there is no room for prose, and dropping it
  // is what buys the density. The full title stays on hover, so a marker is
  // still identifiable without a click, and a click still selects it into the
  // inspector exactly as thread and flight do.
  //
  // What a MAIN-THREAD marker does carry (owner's UAT) is a one-character kind
  // mark, so prompt / reply / tool / thinking / sub-agent are told apart without
  // clicking. A cell INSIDE a chamber stays bare: a chamber is a dense block by
  // design and marking every cell in one would undo the density it bought.
  //
  // Colours are theme vars ONLY, and the tone comes from the SAME stepGlyph
  // model the other two modes use — no second colour language here.
  import { minimapLayout, type MinimapStep } from './labyrinthMinimap';
  import { kindMark, markSize, markX, markY } from './labyrinthMarks';
  import { isThreshold, pathPoints, stepGlyph, type LayoutStep } from './labyrinthLayout';

  let {
    steps, selected, onSelect, dim,
  }: {
    steps: LayoutStep[];
    selected: number | null;
    onSelect: (step: LayoutStep) => void;
    dim: ReadonlySet<number>; // ordinals to FADE while a spend chip is hovered; empty = nothing is
  } = $props();

  let map = $derived(minimapLayout(steps as unknown as Array<LayoutStep & MinimapStep>));
  // 0 once the cells are too small for a legible character — the mark is then
  // dropped wholesale rather than drawn as a smear.
  let mark = $derived(markSize(Math.min(map.cellW, map.rowH)));
</script>

<!-- Chambers first, so a nested marker is never hidden under its own room. -->
{#each map.chambers as c (c.key)}
  <rect class="chamber" class:is-dim={dim.has(steps[c.key]?.ordinal ?? -1)} x={c.x} y={c.y} width={c.w} height={c.h} rx="4">
    <title>{c.count} delegated step{c.count === 1 ? '' : 's'}</title>
  </rect>
{/each}
{#if map.trail.length > 1}
  <polyline class="corridor-path" points={pathPoints(map.trail)} />
{/if}

{#each map.points as p (p.step.ordinal)}
  <g
    class="node tone-{stepGlyph(p.step)}"
    class:is-selected={selected === p.step.ordinal}
    class:is-threshold={isThreshold(p.step)}
    class:in-chamber={p.chamber >= 0} class:is-dim={dim.has(p.step.ordinal)}
    role="button"
    tabindex="0"
    aria-label={p.step.title}
    data-ordinal={p.step.ordinal}
    onclick={() => onSelect(p.step)}
    onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.step); } }}
  >
    <title>{p.step.tool ? `${p.step.kind}: ${p.step.tool} — ` : ''}{p.step.title}</title>
    <circle class="hit" cx={p.x} cy={p.y} r={Math.max(p.r * 2, 7)} />
    <circle
      class="marker"
      cx={p.x}
      cy={p.y}
      r={selected === p.step.ordinal ? p.r * 1.7 : p.r}
      fill={isThreshold(p.step) || selected === p.step.ordinal ? 'currentColor' : 'var(--og-surface)'}
    />
    <!-- Main thread only, and only while the cells are big enough to read. -->
    {#if p.chamber < 0 && mark > 0 && kindMark(p.step.kind)}
      <text class="mark" x={markX(p.x, p.r)} y={markY(p.y, mark)} font-size={mark} aria-hidden="true">{kindMark(p.step.kind)}</text>
    {/if}
  </g>
{/each}

<style>
  .node { cursor: pointer; outline: none; color: var(--og-text-secondary); }
  .tone-prompt { color: var(--og-chat); }
  .tone-reply { color: var(--og-text); }
  .tone-thinking { color: var(--og-text-muted); }
  .tone-tool { color: var(--og-success); }
  .tone-subagent { color: var(--og-accent-2); }
  .tone-error { color: var(--og-error); }
  .hit { fill: transparent; }
  /* currentColor, so the mark takes the SAME tone as its marker — the kind's
     letter and the kind's colour cannot drift apart. */
  .mark { fill: currentColor; font-weight: 600; }
  .marker { stroke: currentColor; stroke-width: 1.2; }
  .node:hover .marker { stroke-width: 2.2; }
  .node:focus-visible .marker { stroke-width: 2.2; }
  .node.is-selected .marker { stroke: var(--og-text); stroke-width: 2; }
  /* The delegated stretch as a ROOM off the corridor, not a stripe on it. */
  .chamber { fill: var(--og-surface-alt); stroke: var(--og-accent-2); stroke-width: 1; opacity: 0.75; }
  .node.is-dim, .chamber.is-dim { opacity: 0.14; } /* a hovered spend chip fades what it is NOT about */
  .corridor-path { fill: none; stroke: var(--og-border); stroke-width: 1; }
</style>
