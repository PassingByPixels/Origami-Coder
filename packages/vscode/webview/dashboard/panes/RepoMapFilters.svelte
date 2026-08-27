<script lang="ts">
  // The map screen's LEFT rail: find a component, and the two click-to-filter
  // legends (kind, pillar). Extracted from RepoMapScreen.svelte rather than grown
  // inside it — the pane was already carrying the header, the stage and the right
  // rail, and the filters are the half with rules worth testing on their own
  // (repoMapFilters.ts).
  //
  // The counts come from the map, not from the palette: `kind` is a free string in
  // the schema, so a legend built from the palette alone would omit a kind a
  // cartographer actually used and offer no way to filter it.
  import type { IsoBox } from '../../../src/dashboard/agentManager/isoLayout';
  import { kindColour, pillarColour } from '../components/repoMapPalette';
  import { PILLARS } from '../components/repoMapPillars';
  import { countBy, kindsIn } from '../components/repoMapFilters';

  let {
    boxes, query, hiddenKinds, hiddenPillars, onQuery, onToggleKind, onTogglePillar,
  }: {
    boxes: readonly IsoBox[];
    query: string;
    hiddenKinds: ReadonlySet<string>;
    hiddenPillars: ReadonlySet<number>;
    onQuery: (q: string) => void;
    onToggleKind: (kind: string) => void;
    onTogglePillar: (pillar: number) => void;
  } = $props();

  let kindCounts = $derived(countBy(boxes, (b) => b.kind));
  let kinds = $derived(kindsIn(kindCounts.keys()));
  let pillarCounts = $derived(countBy(boxes, (b) => b.pillar));
</script>

<aside class="rail">
  <div>
    <div class="stitle">Find a component</div>
    <input class="search" placeholder="name, path, summary…" value={query}
      oninput={(e) => onQuery((e.currentTarget as HTMLInputElement).value)} />
  </div>
  <div>
    <div class="stitle">Kind — click to filter</div>
    {#each kinds as k (k)}
      <button class="legend" class:off={hiddenKinds.has(k)} onclick={() => onToggleKind(k)}>
        <span class="cube" style="background: {kindColour(k)}"></span>{k}
        <span class="n">{kindCounts.get(k) ?? 0}</span>
      </button>
    {/each}
    <div class="edges">
      <div><i class="static"></i><span>static dependency</span></div>
      <div><i class="hot"></i><span>selected connection</span></div>
    </div>
  </div>
  <div>
    <div class="stitle">Pillars — click to filter</div>
    <ul class="pillars">
      {#each PILLARS as p (p.number)}
        <li>
          <button class:off={hiddenPillars.has(p.number)} style="border-left-color: {pillarColour(p.number)}"
            onclick={() => onTogglePillar(p.number)}>{p.number} · {p.name}
            <span class="n">{pillarCounts.get(p.number) ?? 0}</span></button>
        </li>
      {/each}
    </ul>
  </div>
</aside>

<style>
  .rail { display: flex; flex-direction: column; gap: 14px; overflow-y: auto; padding: 12px;
    border-right: 1px solid var(--og-border); height: 100%; min-height: 0; }
  .stitle { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--og-text-muted); margin-bottom: 7px; }
  .search { width: 100%; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px;
    padding: 6px 9px; color: var(--og-text); font: inherit; font-size: 12px; }
  .search:focus { outline: none; border-color: var(--og-accent); }
  .legend { display: flex; align-items: center; gap: 8px; width: 100%; font: inherit; font-size: 11px;
    margin-bottom: 4px; cursor: pointer; background: none; border: 0; color: inherit; text-align: left; padding: 0; }
  .legend.off, .pillars button.off { opacity: 0.35; }
  .cube { width: 11px; height: 11px; flex-shrink: 0; border-radius: 2px; }
  .n { color: var(--og-text-muted); font-size: 10px; margin-left: auto; }
  .edges { margin-top: 9px; font-size: 10px; color: var(--og-text-muted); }
  .edges div { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .edges i { width: 22px; height: 2px; flex-shrink: 0; }
  .edges i.static { background: var(--og-text-muted); }
  .edges i.hot { background: var(--og-accent); }
  .pillars { list-style: none; margin: 0; padding: 0; }
  .pillars button { display: flex; width: 100%; font: inherit; font-size: 11px; padding: 5px 7px; margin-bottom: 3px;
    background: var(--og-surface); border: 0; border-left: 3px solid var(--og-border); border-radius: 4px;
    color: var(--og-text-muted); cursor: pointer; line-height: 1.3; text-align: left; }
  .pillars button:hover, .legend:hover { color: var(--og-text); }
</style>
