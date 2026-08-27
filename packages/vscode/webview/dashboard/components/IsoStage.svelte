<script lang="ts">
  // The isometric STAGE — the map's picture, the camera that moves it, and the
  // card that reads out whatever is under the pointer.
  //
  // It DRAWS nothing itself: the ground, the solids, the wires and the captions
  // are four leaves (IsoGround / IsoNodes / IsoWires / IsoLabels), in that order,
  // because SVG paints in document order and that order IS the layering — a
  // caption emitted beside its plate would vanish under the first tall box.
  //
  // NO GEOMETRY IS COMPUTED HERE. Every coordinate arrives already projected in
  // the tab payload (isoLayout.ts, host side), and the boxes arrive in painter's
  // order — so this component and the static map.html artifact draw the very same
  // numbers. Only the camera arithmetic is local, and that lives in the pure
  // isoView.ts beside it.
  import type { IsoBox, IsoLayout } from '../../../src/dashboard/agentManager/isoLayout';
  import type { MapFlow } from '../../../src/dashboard/agentManager/mapSchema';
  import IsoGround from './IsoGround.svelte';
  import IsoNodes from './IsoNodes.svelte';
  import IsoWires from './IsoWires.svelte';
  import IsoLabels from './IsoLabels.svelte';
  import { kindColour } from './repoMapPalette';
  import { PILLARS } from './repoMapPillars';
  import type { LabelMode } from './repoMapFilters';
  import { camAttr, dragBy, fitOf, HOME, toUser, viewBoxAttr, zoomAt, type Camera } from './isoView';

  let {
    layout, flows, keyPaths, selected, flowId, dimIds, hideIds, labelMode, showEdges, onPick,
  }: {
    layout: IsoLayout;
    flows: readonly MapFlow[];
    keyPaths: ReadonlySet<string>;
    selected: string;
    flowId: string;
    dimIds: ReadonlySet<string>;
    hideIds: ReadonlySet<string>;
    labelMode: LabelMode;
    showEdges: boolean;
    onPick: (id: string) => void;
  } = $props();

  let cam = $state<Camera>({ ...HOME });
  let svgEl = $state<SVGSVGElement | undefined>(undefined);
  let hovered = $state<IsoBox | null>(null);
  let tip = $state({ x: 0, y: 0 });
  let drag: { x: number; y: number; s: number; from: Camera } | null = $state(null);

  export function home(): void { cam = { ...HOME }; }

  const rect = (): DOMRect | undefined => svgEl?.getBoundingClientRect();
  const pillarName = (n: number): string => PILLARS.find((p) => p.number === n)?.name ?? `Pillar ${n}`;

  function onWheel(ev: WheelEvent): void {
    const u = toUser(rect(), layout.view, ev.clientX, ev.clientY);
    if (!u) return; // no layout yet (hidden tab, headless DOM) — never divide by 0
    ev.preventDefault();
    cam = zoomAt(cam, u.x, u.y, ev.deltaY < 0 ? 1 : -1);
  }
  function onDown(ev: MouseEvent): void {
    const f = fitOf(rect(), layout.view);
    if (!f) return;
    drag = { x: ev.clientX, y: ev.clientY, s: f.s, from: { ...cam } };
  }
  function onMove(ev: MouseEvent): void {
    if (!drag) return;
    cam = dragBy(drag.from, ev.clientX - drag.x, ev.clientY - drag.y, drag.s);
  }
  /** The card follows the pointer, flipping to the other side near an edge so it
   *  is never half outside the pane. */
  function track(ev: MouseEvent): void {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    tip = { x: x > r.width - 310 ? Math.max(6, x - 302) : x + 16, y: y > r.height - 160 ? Math.max(6, y - 150) : y + 16 };
  }
</script>

<svelte:window onmousemove={onMove} onmouseup={() => (drag = null)} />

<div class="iso" class:grabbing={!!drag} onwheel={onWheel} onmousedown={onDown} onmousemove={track} role="presentation">
  <svg bind:this={svgEl} viewBox={viewBoxAttr(layout.view)} preserveAspectRatio="xMidYMid meet">
    <g transform={camAttr(cam)}>
      <IsoGround {layout} />
      <IsoNodes {layout} {selected} {dimIds} {hideIds} {onPick}
        onHover={(b) => (hovered = b)} onLeave={() => (hovered = null)} />
      <IsoWires {layout} {selected} {flowId} {showEdges} />
      <IsoLabels {layout} {flows} {hideIds} {labelMode} zoom={cam.k} />
    </g>
  </svg>
  {#if hovered}
    <div class="tip" style="left: {tip.x}px; top: {tip.y}px">
      <div class="t-name">{hovered.name}</div>
      <div class="t-meta">
        <span class="chip" style="background: color-mix(in srgb, {kindColour(hovered.kind)} 20%, transparent);
          color: {kindColour(hovered.kind)}">{hovered.kind}</span>
        pillar {hovered.pillar} · {pillarName(hovered.pillar)}{hovered.section ? ` · ${hovered.section}` : ''}
        · {hovered.degree} edge{hovered.degree === 1 ? '' : 's'}{hovered.path && keyPaths.has(hovered.path) ? ' · KEY FILE' : ''}
      </div>
      <div class="t-sum">{hovered.summary}</div>
      {#if hovered.path}<div class="t-path">{hovered.path}</div>{/if}
    </div>
  {/if}
</div>

<style>
  .iso { position: relative; overflow: hidden; min-width: 0; min-height: 0; cursor: grab; flex: 1;
    background: radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--og-accent) 7%, transparent), transparent 60%); }
  .iso.grabbing { cursor: grabbing; }
  svg { width: 100%; height: 100%; display: block; touch-action: none; }
  .tip { position: absolute; pointer-events: none; z-index: 4; max-width: 290px; background: var(--og-surface);
    border: 1px solid var(--og-border); border-radius: 7px; padding: 8px 10px; font-size: 11px; line-height: 1.45;
    box-shadow: 0 8px 24px color-mix(in srgb, var(--og-bg) 70%, transparent); }
  .t-name { font-weight: 600; font-size: 12px; margin-bottom: 3px; }
  .t-meta { font-size: 10px; color: var(--og-text-muted); margin-bottom: 5px; }
  .t-sum { color: var(--og-text); }
  .t-path { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px;
    color: var(--og-text-muted); margin-top: 5px; word-break: break-all; }
  .chip { display: inline-block; font-size: 9px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 2px 6px; border-radius: 4px; }
</style>
