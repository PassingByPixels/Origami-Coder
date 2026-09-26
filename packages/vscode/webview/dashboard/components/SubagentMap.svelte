<script lang="ts">
  // SubagentMap.svelte — the LIVE agent map (t-z1xlfy, the mockup's "Sub-agents
  // pull-out and agent map"): a dot-grid canvas with this chat's hub at the left,
  // a column per tier, each child starting on its parent's row, rounded elbow
  // wires that join at the parent, and background tasks as dashed chips after
  // their owner. The canvas scrolls on both axes, pans on a drag of empty space,
  // and zooms (− / + / Fit / 1:1, Ctrl + wheel around the pointer).
  //
  // Every position is agentMapLayout.ts's (pure, tested): nothing here is measured.
  // The world scales with a transform; an empty sizer sizes the scroll area.
  import { tick } from 'svelte';
  import { agentTree, HUB, taskEnd, type AgentTreeData, type TreeTask } from '../panes/agentTree';
  import { chainOf, clampZoom, fitZoom, layoutMap, mapHubLine, scrollAround, ZOOM_STEP } from '../panes/agentMapLayout';
  import { elapsedText } from '../panes/subagentFormat';
  import { subagentShort } from '../panes/subagentLabel';
  import { tokensTitle } from '../panes/subagentTokens';
  import { tip } from '../../shared/warmTip';
  import type { SubagentRow } from '../panes/subagentRows';
  import SubagentCardFace from './SubagentCardFace.svelte';
  import SubagentCounts from './SubagentCounts.svelte';
  import AgentMapChip from './AgentMapChip.svelte';
  import AgentMapZoom from './AgentMapZoom.svelte';
  import { fitMapPanel } from './agentMapFit'; // t-ze0hwh: a centred panel, ~1.2x the pre-t-z1xlfy size

  interface Props {
    /** The direct children: the pull-out's own rows. */
    rows: SubagentRow[];
    /** What sits at the hub — this chat's own name. */
    title: string;
    /** The host's roster + sub-agents' background shells (agentTree.ts). */
    tree?: AgentTreeData;
    /** This chat's own background shells, off its bash cards. */
    chatTasks?: TreeTask[];
    onOpen: (row: SubagentRow) => void;
    onClose: () => void;
  }
  let { rows, title, tree, chatTasks = [], onOpen, onClose }: Props = $props();

  let now = $state(Date.now());
  const view = $derived(agentTree(rows, tree, chatTasks, now));
  const layout = $derived(layoutMap(view));
  const allRows = $derived(view.agents.map((a) => a.row));
  const bgRunning = $derived(view.tasks.filter((t) => t.status === 'running').length);
  const byKey = $derived(new Map(allRows.map((r) => [r.key, r])));
  const ownerName = (key: string) => (key === HUB ? 'this chat' : byKey.get(key) ? subagentShort(byKey.get(key)!) : key);
  const cardTip = (r: SubagentRow) =>
    [r.taskSessionId ? `Open ${r.title}` : `${r.title} — this spawn never created a sub-agent session`, r.model, tokensTitle(r.tokens)].filter(Boolean).join(' — ');

  // Chips tick once a second while one runs; a nested row's age ticks on the same clock.
  const live = $derived(bgRunning > 0 || allRows.some((r) => !r.settled));
  $effect(() => {
    if (!live) return;
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });

  let zoom = $state(1);
  let canvas = $state<HTMLDivElement>();
  async function setZoom(to: 'out' | 'in' | 'fit' | 'one' | number, around?: { x: number; y: number }) {
    const old = zoom, c = canvas;
    zoom = to === 'fit' ? fitZoom(canvas?.clientWidth ?? 0, canvas?.clientHeight ?? 0, layout.width, layout.height)
      : to === 'in' ? clampZoom(old * ZOOM_STEP) : to === 'out' ? clampZoom(old / ZOOM_STEP) : to === 'one' ? 1 : clampZoom(to);
    if (!c) return;
    const s = to === 'fit' ? { left: 0, top: 0 } : around ? scrollAround({ left: c.scrollLeft, top: c.scrollTop }, around, old, zoom) : null;
    await tick(); // the sizer has its new size before the scroll is set, or the browser clamps it
    if (s) { c.scrollLeft = s.left; c.scrollTop = s.top; }
  }
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey || !canvas) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    void setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX - r.left, y: e.clientY - r.top });
  }
  // Drag on empty canvas pans both axes; the wheel and the scrollbars also work.
  let panning = $state(false);
  function onPointerDown(e: PointerEvent) {
    const c = canvas;
    if (!c || e.button !== 0 || (e.target as Element).closest('.am-card, .am-chip, .am-hub')) return;
    const x0 = e.clientX, y0 = e.clientY, l0 = c.scrollLeft, t0 = c.scrollTop;
    panning = true;
    c.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => { c.scrollLeft = l0 - (ev.clientX - x0); c.scrollTop = t0 - (ev.clientY - y0); };
    const up = () => { panning = false; c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
  }

  // Hover a card: its chain up to the chat stays bright, the rest dims.
  let hover = $state<string | null>(null);
  const lit = $derived(hover ? chainOf(layout.items, hover) : null), dim = (key: string) => !!lit && !lit.has(key);
  // The first paint staggers in (capped: a big map must not take seconds); later arrivals do not wait.
  let entering = $state(true);
  $effect(() => { const t = setTimeout(() => { entering = false; }, 700); return () => clearTimeout(t); });

  // Escape closes, from anywhere in the window: the overlay covers the chat cell.
  $effect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<div class="sm-scrim" role="dialog" aria-modal="true" aria-label="Agent map">
  <div class="sm-panel" use:fitMapPanel>
    <div class="sm-head">
      <span class="sm-title">Agent map</span>
      <SubagentCounts rows={allRows} />
      <span class="am-bgc" use:tip={'Background tasks running'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6" /></svg>{bgRunning}<span class="am-sr">{' background'}</span></span>
      <span class="sm-sp"></span>
      <AgentMapZoom {zoom} onZoom={(to) => void setZoom(to)} />
      <button class="sm-close" aria-label="Close the agent map" use:tip={'Close (Esc)'} onclick={onClose}>&times;</button>
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="am-canvas" class:am-panning={panning} bind:this={canvas} onwheel={onWheel} onpointerdown={onPointerDown} onmouseleave={() => (hover = null)}>
      <div class="am-sizer" style="width: {layout.width * zoom}px; height: {layout.height * zoom}px;"></div>
      <div class="am-world" class:am-enter={entering} style="width: {layout.width}px; height: {layout.height}px; transform: scale({zoom});">
        <svg class="am-wires" width={layout.width} height={layout.height} aria-hidden="true">
          {#each layout.items as it (it.key)}
            <path class="am-w am-w-{it.wire}" class:am-dimw={dim(it.key)} d={it.path} />
            {#if it.wire === 'running'}<path class="am-flow" pathLength="1" d={it.path} />{/if}
          {/each}
        </svg>
        <div class="am-hub" style="left: {layout.hub.x}px; top: {layout.hub.y}px; width: {layout.hub.w}px; height: {layout.hub.h}px;">
          <span class="am-hub-name" use:tip={title}>{title}</span>
          <span class="am-hub-kind">{mapHubLine(allRows, layout.tiers, bgRunning)}</span>
        </div>
        {#each layout.items as it, i (it.key)}
          <div class="am-at" style="left: {it.x}px; top: {it.y}px; width: {it.w}px; height: {it.h}px; --i: {entering ? Math.min(i + 1, 12) : 0};" onmouseenter={() => (hover = it.key)} role="presentation">
            {#if it.agent}
              {@const r = it.agent.row}
              <button class="am-card" class:am-dim={dim(it.key)} data-s={it.wire} data-k={it.key} disabled={!r.taskSessionId} use:tip={cardTip(r)} onclick={() => onOpen(r)}>
                <SubagentCardFace row={r} />
              </button>
            {:else if it.task}
              <AgentMapChip task={it.task} ownerName={ownerName(it.owner)} dim={dim(it.key)} end={taskEnd(it.task, byKey.get(it.owner), now, elapsedText)} />
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .sm-scrim { position: absolute; inset: 0; z-index: 14; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.55); }
  .sm-panel {
    display: flex; flex-direction: column; min-height: 0; overflow: hidden;
    background: var(--og-bg); border: 1px solid var(--og-border); border-radius: 10px; box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
  }
  .sm-head { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; padding: 8px 10px 8px 12px; border-bottom: 1px solid var(--og-border); background: var(--og-surface); }
  .sm-title { font-size: 12px; font-weight: 600; color: var(--og-text); } .sm-sp { flex: 1 1 auto; }
  .am-bgc { display: inline-flex; align-items: center; gap: 3px; font-size: 9.5px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .am-bgc svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .am-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .sm-close { background: none; border: none; color: var(--og-text-muted); cursor: pointer; font-size: 15px; line-height: 1; padding: 0 3px; border-radius: 3px; font-family: inherit; }
  .sm-close:hover { color: var(--og-text); background: var(--og-btn-bg); }

  /* The dot grid is the canvas's own background, so it scrolls with nothing and fills any size. */
  .am-canvas {
    position: relative; flex: 1 1 auto; min-height: 0; overflow: auto; cursor: grab;
    background: radial-gradient(circle, color-mix(in srgb, var(--og-border) 55%, transparent) 1px, transparent 1.2px) 0 0 / 18px 18px, var(--og-bg);
  }
  .am-panning { cursor: grabbing; user-select: none; } .am-dimw { opacity: 0.18; } .am-dim { opacity: 0.45; }
  .am-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .am-wires { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .am-w { fill: none; stroke: var(--og-border); stroke-width: 1.3; transition: opacity 200ms ease; }
  .am-w-done { stroke: color-mix(in srgb, var(--og-success) 45%, var(--og-border)); }
  .am-w-running { stroke: color-mix(in srgb, var(--og-chat) 40%, var(--og-border)); }
  .am-w-failed { stroke: color-mix(in srgb, var(--og-error) 55%, var(--og-border)); stroke-dasharray: 3 4; }
  /* A light runs down a running agent's wire. */
  .am-flow { fill: none; stroke: var(--og-chat); stroke-width: 1.6; stroke-linecap: round; stroke-dasharray: 0.12 1.12; animation: am-flow 1.8s cubic-bezier(0.77, 0, 0.175, 1) infinite; }
  @keyframes am-flow { from { stroke-dashoffset: 0.12; } to { stroke-dashoffset: -1; } }

  .am-hub { position: absolute; box-sizing: border-box; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--og-border); background: var(--og-surface); overflow: hidden; }
  .am-hub-name { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; font-weight: 600; line-height: 1.35; color: var(--og-text); }
  .am-hub-kind { display: block; margin-top: 3px; font-size: 10px; color: var(--og-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .am-at { position: absolute; transition: top 350ms cubic-bezier(0.23, 1, 0.32, 1); }
  .am-enter .am-at { animation: am-in 350ms cubic-bezier(0.23, 1, 0.32, 1) backwards; animation-delay: calc(var(--i, 0) * 40ms); }
  @keyframes am-in { from { opacity: 0; transform: translateY(6px); } }
  .am-card {
    box-sizing: border-box; width: 100%; height: 100%; overflow: hidden;
    display: flex; flex-direction: column; gap: 3px; padding: 7px 9px 9px;
    background: var(--og-bg); border: 1px solid var(--og-border); border-radius: 8px;
    cursor: pointer; font-family: inherit; text-align: left; transition: border-color 120ms ease, opacity 200ms ease;
  }
  .am-card:hover:not(:disabled) { border-color: var(--og-text-muted); }
  .am-card[data-s='running'] { border-color: color-mix(in srgb, var(--og-chat) 45%, var(--og-border)); }
  .am-card:disabled { cursor: default; opacity: 0.7; }
  @media (prefers-reduced-motion: reduce) {
    .am-flow { display: none; }
    .am-enter .am-at { animation: none; }
    .am-at, .am-card, .am-w { transition: none; }
  }
</style>
