<script lang="ts">
  // The map screen's RIGHT rail: what the repository is, the flows you can trace,
  // and whatever is currently selected — a component with its connections, a flow
  // with its steps, or, when nothing is picked, the map's own index (summary, key
  // files, conventions).
  //
  // Extracted from RepoMapScreen.svelte with the left rail, for the same reason.
  // The pane above now owns state and layout; these two own their own markup.
  import type { IsoBox } from '../../../src/dashboard/agentManager/isoLayout';
  import type { RepoMap } from '../../../src/dashboard/agentManager/mapSchema';
  import { flowColour, kindColour } from '../components/repoMapPalette';
  import { PILLARS, STATUS_COLOR } from '../components/repoMapPillars';

  /** What each `status` means, spelled out. Carried over from the pillar-column
   *  screen deliberately: a one-word chip tells the reader the field exists, it
   *  never tells them what it is claiming. The mockup has only the chip. */
  const CONDITION: Record<string, string> = {
    new: 'new — absent from the previous map.',
    modified: 'modified — it changed since the previous map was built.',
    removed: 'removed — the previous map had it; the code no longer does.',
    unchanged: 'unchanged since the previous map.',
  };

  let {
    map, shown, flowId, keyWhy, nameOf, onFlow,
  }: {
    map: RepoMap;
    /** The selected component, or null when a flow or nothing is selected. */
    shown: IsoBox | null;
    flowId: string;
    keyWhy: ReadonlyMap<string, string>;
    nameOf: (id: string) => string;
    onFlow: (id: string) => void;
  } = $props();

  const pillarName = (n: number): string => PILLARS.find((p) => p.number === n)?.name ?? `Pillar ${n}`;
  let flow = $derived(map.flows.find((f) => f.id === flowId) ?? null);
  let flowIndex = $derived(map.flows.findIndex((f) => f.id === flowId));
  let wired = $derived(map.edges.filter((e) => shown && (e.from === shown.id || e.to === shown.id)));
  let inFlows = $derived(map.flows.filter((f) => shown && f.steps.some((s) => s.node === shown.id)));
</script>

<aside class="rail">
  <div>
    <div class="stitle">Repository</div>
    <p class="prose">{map.summary}</p>
  </div>

  <div>
    <div class="stitle">Flows — click to trace</div>
    {#if map.flows.length === 0}
      <p class="prose">This map records no flows.</p>
    {:else}
      {#each map.flows as f, i (f.id)}
        <button class="flow" class:on={f.id === flowId} style="border-left-color: {flowColour(i)}"
          onclick={() => onFlow(f.id)}><span class="fid">{f.id}</span>{f.name}</button>
      {/each}
    {/if}
  </div>

  {#if shown}
    <div class="detail">
      <h3>{shown.name}</h3>
      <span class="chip" style="background: color-mix(in srgb, {kindColour(shown.kind)} 20%, transparent);
        color: {kindColour(shown.kind)}">{shown.kind}</span>
      {#if shown.status}<span class="chip warn">{shown.status}</span>{/if}
      {#if shown.path && keyWhy.has(shown.path)}<span class="chip key">key file</span>{/if}
      <div class="meta">Pillar {shown.pillar} · {pillarName(shown.pillar)}
        {#if shown.section}<br />Section: {shown.section}{/if}</div>
      <p>{shown.summary}</p>
      {#if shown.status}
        <p class="cond" style="color: {STATUS_COLOR[shown.status] ?? 'inherit'}">{CONDITION[shown.status] ?? shown.status}</p>
      {/if}
      {#if shown.path}<div class="path">{shown.path}</div>{/if}
      {#if shown.path && keyWhy.has(shown.path)}<p class="key-why">Key file — {keyWhy.get(shown.path)}</p>{/if}
      <div class="stitle">Connections ({wired.length})</div>
      <ul>
        {#each wired as e, i (i)}
          <li>{e.from === shown.id ? '→' : '←'} <b>{nameOf(e.from === shown.id ? e.to : e.from)}</b><br />{e.label}</li>
        {:else}
          <li>No edges recorded for this component.</li>
        {/each}
      </ul>
      {#if inFlows.length > 0}
        <div class="stitle">Appears in flows</div>
        <ul>{#each inFlows as f (f.id)}<li><b>{f.name}</b></li>{/each}</ul>
      {/if}
    </div>
  {:else if flow}
    <div class="detail">
      <h3 style="color: {flowColour(flowIndex)}">{flow.name}</h3>
      <div class="meta mono">{flow.id} · {flow.steps.length} steps</div>
      <p>{flow.description}</p>
      <div class="stitle">Path</div>
      <div class="stepbox">
        {#each flow.steps as s, i (i)}
          <div class="steprow">
            <div class="stepn" style="background: {flowColour(flowIndex)}">{i + 1}</div>
            <div><div class="sn">{nameOf(s.node)}</div><div class="sd">{s.note}</div></div>
          </div>
        {/each}
      </div>
    </div>
  {:else}
    <div class="detail">
      <div class="stitle">About this map</div>
      <p class="prose">{map.summary}</p>
      {#if map.keyFiles && map.keyFiles.length > 0}
        <div class="stitle">Key files ({map.keyFiles.length})</div>
        <ul class="kf">{#each map.keyFiles as k (k.path)}<li><b>{k.path}</b><br />{k.why}</li>{/each}</ul>
      {/if}
      {#if map.conventions && map.conventions.length > 0}
        <div class="stitle">Conventions</div>
        <ul class="conv">{#each map.conventions as c (c)}<li>{c}</li>{/each}</ul>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .rail { display: flex; flex-direction: column; gap: 14px; overflow-y: auto; padding: 12px;
    border-left: 1px solid var(--og-border); height: 100%; min-height: 0; }
  .stitle { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--og-text-muted); margin: 14px 0 7px; }
  .rail > div > .stitle:first-child, .detail > .stitle:first-child { margin-top: 0; }
  .prose { font-size: 11px; color: var(--og-text-muted); line-height: 1.45; margin: 0; }
  .flow { display: block; width: 100%; text-align: left; background: var(--og-surface); border: 1px solid var(--og-border);
    border-left-width: 3px; border-radius: 6px; padding: 7px 9px; color: var(--og-text); font: inherit; font-size: 12px;
    cursor: pointer; margin-bottom: 5px; line-height: 1.3; }
  .flow:hover, .flow.on { border-color: var(--og-accent); background: color-mix(in srgb, var(--og-accent) 12%, transparent); }
  .fid { display: block; font-size: 10px; color: var(--og-text-muted);
    font-family: var(--vscode-editor-font-family, monospace); }
  .detail h3 { font-size: 13px; margin: 0 0 5px; line-height: 1.3; }
  .detail .meta { font-size: 10px; color: var(--og-text-muted); margin: 6px 0; }
  .detail .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .detail p { font-size: 11.5px; line-height: 1.5; margin: 0; }
  .detail .key-why { color: var(--og-accent); font-size: 11px; margin-top: 8px; }
  .detail .cond { font-size: 11px; margin-top: 8px; }
  .path { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text-muted);
    margin-top: 8px; word-break: break-all; background: var(--og-bg); padding: 6px 7px; border-radius: 4px;
    border: 1px solid var(--og-border); }
  ul { list-style: none; margin: 8px 0 0; padding: 0; }
  li { font-size: 11px; color: var(--og-text-muted); padding: 4px 0; line-height: 1.4;
    border-bottom: 1px solid var(--og-border); }
  li b { color: var(--og-text); font-weight: 600; }
  .kf li { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; word-break: break-all; }
  .conv li::before { content: '>'; color: var(--og-accent); margin-right: 6px; }
  .chip { display: inline-block; font-size: 9px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 2px 6px; border-radius: 4px; }
  .chip.warn { background: color-mix(in srgb, var(--og-warning) 20%, transparent); color: var(--og-warning); }
  .chip.key { background: color-mix(in srgb, var(--og-accent) 20%, transparent); color: var(--og-accent); }
  .stepbox { margin-top: 9px; background: var(--og-bg); border: 1px solid var(--og-border);
    border-radius: 6px; padding: 8px; }
  .steprow { display: flex; gap: 7px; font-size: 11px; margin-bottom: 6px; align-items: flex-start; }
  .stepn { width: 17px; height: 17px; border-radius: 50%; color: var(--og-bg); font-size: 9px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
  .sn { color: var(--og-text); font-weight: 600; }
  .sd { color: var(--og-text-muted); font-size: 10px; line-height: 1.4; }
</style>
