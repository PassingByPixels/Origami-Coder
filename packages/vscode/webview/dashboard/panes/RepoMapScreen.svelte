<script lang="ts">
  // Repo architecture-map SCREEN (S15) — the CARTOGRAPHER's map as the FLOW-SPINE
  // isometric drawing (Passing's pick of the mockups). A slim header, a filter
  // rail, the picture, and a rail carrying the repository, the flows and whatever
  // is selected. Both rails drag to resize and fold away, so the map can have the
  // whole pane.
  //
  // THE GEOMETRY IS NOT COMPUTED HERE, and that is the whole design. It arrives in
  // the tab payload, already projected by the extension host
  // (src/dashboard/agentManager/isoLayout.ts), so the static .origami/map/map.html
  // artifact and this screen draw identical numbers — one layout, two renderers.
  // The webview cannot import that module's runtime (rootDir is pinned to
  // webview/), so it imports only its TYPE, which the compiler checks. Nothing is
  // mirrored, so nothing can drift. See mapTab.ts's RepoMapPayload.
  //
  // This file now owns STATE and LAYOUT only: the picture is IsoStage.svelte and
  // its four leaves, the rails are RepoMapFilters/RepoMapDetail, the filter rules
  // are components/repoMapFilters.ts, and the pillar + palette mirrors are
  // components/repoMapPillars.ts.
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import IsoStage from '../components/IsoStage.svelte';
  import LabyrinthDivider from '../components/LabyrinthDivider.svelte';
  import RepoMapFilters from './RepoMapFilters.svelte';
  import RepoMapDetail from './RepoMapDetail.svelte';
  import { flowNodeIds } from '../components/isoView';
  import { matches, nextLabelMode, type LabelMode } from '../components/repoMapFilters';
  import type { IsoLayout } from '../../../src/dashboard/agentManager/isoLayout';
  import type { MapBuiltAt, RepoMap } from '../../../src/dashboard/agentManager/mapSchema';

  interface Params { root: string; name: string; map: RepoMap; layout: IsoLayout }

  const MIN_RAIL = 150;
  const DEFAULT_LEFT = 214;
  const DEFAULT_RIGHT = 296;

  let data = $state<Params | null>(null);
  let selected = $state('');
  let flowId = $state('');
  let query = $state('');
  let hiddenKinds = $state<ReadonlySet<string>>(new Set());
  let hiddenPillars = $state<ReadonlySet<number>>(new Set());
  let labelMode = $state<LabelMode>('auto');
  let showEdges = $state(true);
  let leftOpen = $state(true);
  let rightOpen = $state(true);
  let leftWidth = $state<number | null>(null);
  let rightWidth = $state<number | null>(null);
  let stage = $state<IsoStage | undefined>(undefined);
  let paneEl = $state<HTMLElement | undefined>(undefined);

  onMount(() => { data = (window as unknown as { __ORIGAMI_REPO_MAP__?: Params }).__ORIGAMI_REPO_MAP__ ?? null; });

  let map = $derived(data?.map ?? null);
  let layout = $derived(data?.layout ?? null);
  let boxes = $derived(new Map((layout?.boxes ?? []).map((b) => [b.id, b])));
  let shown = $derived(boxes.get(selected) ?? null);
  let flow = $derived(map?.flows.find((f) => f.id === flowId) ?? null);
  let keyWhy = $derived(new Map((map?.keyFiles ?? []).map((k) => [k.path, k.why])));
  let keyPaths = $derived(new Set(keyWhy.keys()));
  let hideIds = $derived(new Set((layout?.boxes ?? [])
    .filter((b) => !matches(b, query, hiddenKinds, hiddenPillars)).map((b) => b.id)));
  // A selection dims everything it is not wired to; a traced flow dims everything
  // off the path. Both at once cannot happen — picking one clears the other.
  let lit = $derived.by(() => {
    if (flowId !== '') return flowNodeIds(flow?.steps);
    if (selected === '') return null;
    const keep = new Set([selected]);
    for (const e of map?.edges ?? []) if (e.from === selected || e.to === selected) { keep.add(e.from); keep.add(e.to); }
    return keep;
  });
  let dimIds = $derived(new Set((layout?.boxes ?? [])
    .filter((b) => lit !== null && lit.size > 0 && !lit.has(b.id)).map((b) => b.id)));

  const nameOf = (id: string): string => boxes.get(id)?.name ?? id;
  const built = (b: MapBuiltAt): string => `${b.branch} @ ${b.sha.slice(0, 7)} · ${new Date(b.at).toISOString().slice(0, 10)}`;
  function pick(id: string): void { selected = selected === id ? '' : id; flowId = ''; }
  function toggleFlow(id: string): void { flowId = flowId === id ? '' : id; selected = ''; }
  function toggleKind(kind: string): void {
    const next = new Set(hiddenKinds);
    if (!next.delete(kind)) next.add(kind);
    hiddenKinds = next;
  }
  function togglePillar(pillar: number): void {
    const next = new Set(hiddenPillars);
    if (!next.delete(pillar)) next.add(pillar);
    hiddenPillars = next;
  }
  function reset(): void { selected = ''; flowId = ''; stage?.home(); }
  /** Save the standalone HTML — the SAME split the Labyrinth export uses: the
   *  webview asks, the extension host owns the dialog and the write. The content
   *  is rendered host-side (renderMapHtml) because only the host has the map
   *  snapshot this tab was opened with, so nothing but the request travels. */
  function exportHtml(): void {
    if (data) getVsCodeApi().postMessage({ type: 'exportRepoMap', root: data.root });
  }
</script>

{#if !map || !layout}
  <div class="rm-empty">No map to show.</div>
{:else}
  <div class="rm">
    <div class="rm-strip">
      <span class="rm-title">{map.name}</span>
      <span class="rm-sub">{layout.boxes.length} components · {map.edges.length} links · {map.flows.length} flows{map.builtAt ? ` · ${built(map.builtAt)}` : ''}</span>
      <div class="rm-tools">
        <button class="rm-btn" class:on={leftOpen} onclick={() => (leftOpen = !leftOpen)}>Filters</button>
        <button class="rm-btn" onclick={() => stage?.home()}>Fit</button>
        <button class="rm-btn" onclick={reset}>Reset</button>
        <button class="rm-btn" onclick={() => (labelMode = nextLabelMode(labelMode))}>Names: {labelMode}</button>
        <button class="rm-btn" class:on={showEdges} onclick={() => (showEdges = !showEdges)}>Edges</button>
        <button class="rm-btn" class:on={rightOpen} onclick={() => (rightOpen = !rightOpen)}>Details</button>
        <button class="rm-btn" onclick={exportHtml} title="Save this map as a self-contained HTML page">Export</button>
      </div>
    </div>

    <div class="rm-cols" bind:this={paneEl}>
      {#if leftOpen}
        <div class="rm-rail" style={leftWidth ? `width: ${leftWidth}px` : undefined}>
          <RepoMapFilters boxes={layout.boxes} {query} {hiddenKinds} {hiddenPillars}
            onQuery={(q) => (query = q)} onToggleKind={toggleKind} onTogglePillar={togglePillar} />
        </div>
        <LabyrinthDivider edge="left" containerEl={paneEl} value={leftWidth} min={MIN_RAIL}
          defaultPx={DEFAULT_LEFT} label="Resize the filter rail"
          onChange={(w) => (leftWidth = w)} onCommit={(w) => (leftWidth = w)} />
      {/if}

      <IsoStage bind:this={stage} {layout} flows={map.flows} {keyPaths} {selected} {flowId}
        {dimIds} {hideIds} {labelMode} {showEdges} onPick={pick} />

      {#if rightOpen}
        <LabyrinthDivider edge="right" containerEl={paneEl} value={rightWidth} min={MIN_RAIL}
          defaultPx={DEFAULT_RIGHT} label="Resize the detail rail"
          onChange={(w) => (rightWidth = w)} onCommit={(w) => (rightWidth = w)} />
        <div class="rm-rail" style={rightWidth ? `width: ${rightWidth}px` : `width: ${DEFAULT_RIGHT}px`}>
          <RepoMapDetail {map} shown={shown} {flowId} {keyWhy} {nameOf} onFlow={toggleFlow} />
        </div>
      {/if}
    </div>

    <div class="rm-hint">drag to pan · wheel to zoom · click a box for its connections · click a flow to trace it</div>
  </div>
{/if}

<style>
  .rm { display: grid; grid-template-rows: auto 1fr auto; height: 100%; min-height: 0; color: var(--og-text); }
  .rm-empty { padding: 16px; font-size: 13px; opacity: 0.7; }
  .rm-strip { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 14px;
    border-bottom: 1px solid var(--og-border); }
  .rm-title { font-size: 13px; font-weight: 700; letter-spacing: 0.03em; }
  .rm-sub { font-size: 10px; color: var(--og-text-muted); font-family: var(--vscode-editor-font-family, monospace); }
  .rm-tools { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
  .rm-btn { font: inherit; font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
    padding: 4px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
    background: var(--og-btn-bg); color: var(--og-btn-text); border: 1px solid var(--og-border); }
  .rm-btn:hover { background: var(--og-btn-hover); border-color: var(--og-accent); }
  .rm-btn.on { border-color: var(--og-accent); color: var(--og-accent);
    background: color-mix(in srgb, var(--og-accent) 12%, transparent); }
  .rm-cols { display: flex; min-height: 0; min-width: 0; }
  .rm-rail { flex-shrink: 0; width: 214px; min-height: 0; background: var(--og-surface); }
  .rm-hint { padding: 6px 14px; border-top: 1px solid var(--og-border); font-size: 10px;
    color: var(--og-text-muted); letter-spacing: 0.04em; }
</style>
