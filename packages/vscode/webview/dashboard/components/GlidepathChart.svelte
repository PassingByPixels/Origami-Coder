<script lang="ts">
  // The hero chart: every connection on ONE normalised axis.
  //
  // HAND-DRAWN SVG, no chart library. A library would add a dependency, a bundle
  // and a theme to fight for a drawing that is six primitives.
  //
  // THE AXIS IS THE FRACTION OF A WINDOW ELAPSED, 0 to 1. Copilot's month and
  // Claude's week are the same width on screen and both end at the SAME reset
  // line, so the eye compares the only thing comparable between a week and a
  // month — the slope against an even burn.
  //
  // WHAT THIS ROUND CHANGED, and why each one:
  //  - PROJECTION GUARD. No projection line and no badge until the window is 10%
  //    elapsed, the readings span 24 h and three hourly points exist. The view
  //    once drew Grok running out on two hours of readings.
  //  - PROJECTIONS IN THE LINE'S OWN COLOUR, so the dashed grey fair-pace
  //    diagonal is the ONLY grey line in the chart and cannot be misread as
  //    somebody's forecast.
  //  - HOURLY RESAMPLE + a monotone curve, so a burst of readings no longer
  //    draws a near-vertical zigzag that reads as a spike.
  //  - NO "NOW" RULE. The lines end at different points of their own windows, so
  //    one vertical could only ever be right about one of them. Each line ends in
  //    its own dot with a direct label instead.
  //  - A COLLISION PASS on those labels, because five connections bunched inside
  //    twenty pixels is one illegible smear exactly where the numbers matter.
  //  - A RESERVED NOTE BAND under the axis, so the coverage note cannot be
  //    landed on by a label that the collision pass pushed down.
  import { layoutLabels, monotonePath, type Point } from './glidepathDraw';
  import { fractionOf, valueAtFraction, type GlideLane } from './glidepathMath';

  let {
    lanes,
    coverageNote,
    guardNote,
    highlight,
    onHighlight,
  }: {
    lanes: readonly GlideLane[];
    coverageNote: string;
    guardNote: string;
    highlight: string | null;
    onHighlight: (providerId: string | null) => void;
  } = $props();

  // The mockup's plot box, in its 740x360 viewBox.
  const L = 46, R = 690, TOP = 42, BOT = 300;

  const x = (f: number) => L + Math.max(0, Math.min(1, f)) * (R - L);
  const y = (pct: number) => BOT - (Math.max(0, Math.min(100, pct)) / 100) * (BOT - TOP);

  const pointsOf = (lane: GlideLane): Point[] =>
    lane.hourly.map((s) => ({ x: x(fractionOf(lane, s.t)), y: y(s.pct) }));

  interface Drawn {
    readonly lane: GlideLane;
    readonly lead: string;
    readonly curve: string;
    readonly end: Point;
    readonly projection?: { readonly to: Point; readonly capped: boolean };
  }

  const drawn = $derived.by((): Drawn[] =>
    lanes.map((lane) => {
      const pts = pointsOf(lane);
      const end = pts[pts.length - 1]!;
      const p = lane.projection;
      const to =
        p === undefined
          ? undefined
          : p.exhaustFrac !== undefined
            ? { x: x(p.exhaustFrac), y: y(100) }
            : { x: x(1), y: y(p.atResetPct) };
      return {
        lane,
        // ONE lead-in per line, from the window's own origin to the first
        // reading: a window is 0% spent at its own start by definition, and a
        // line that begins a third of the way in reads as a flat start that
        // never happened. Thin, half opacity, in the LINE's colour — a grey one
        // would compete with the fair pace.
        lead: `M${x(0).toFixed(2)},${y(0).toFixed(2)}L${pts[0]!.x.toFixed(2)},${pts[0]!.y.toFixed(2)}`,
        curve: monotonePath(pts),
        end,
        ...(to !== undefined ? { projection: { to, capped: p!.exhaustFrac !== undefined } } : {}),
      };
    }),
  );

  // The end labels, spread apart. 14 px is the smallest gap two 9 px labels can
  // hold without touching; the pass is in glidepathDraw.ts so it can be tested
  // without a renderer.
  const labels = $derived(
    layoutLabels(
      drawn.map((d) => ({ lane: d.lane, x: d.end.x, y: d.end.y, ly: d.end.y })),
      14,
      TOP + 4,
      BOT - 2,
    ).map((it) => {
      // Flipped to the left of the dot near the RESET wall, where a right-hand
      // label would be drawn on top of it or clipped away entirely.
      const toRight = it.x < R - 150;
      return { ...it, lx: toRight ? it.x + 9 : it.x - 9, anchor: toRight ? 'start' : 'end' };
    }),
  );

  const dim = (id: string) => highlight !== null && highlight !== id;

  // The crosshair. Its x is webview state, not a lane fact, so it lives here.
  let cross: { frac: number; px: number; py: number } | null = $state(null);

  function onMove(ev: MouseEvent): void {
    const svg = ev.currentTarget as SVGGraphicsElement;
    const box = svg.getBoundingClientRect();
    if (box.width === 0) return;
    const vx = ((ev.clientX - box.left) / box.width) * 740;
    const vy = ((ev.clientY - box.top) / Math.max(1, box.height)) * 360;
    cross = { frac: Math.max(0, Math.min(1, (vx - L) / (R - L))), px: vx, py: vy };
  }

  const readings = $derived(
    cross === null
      ? []
      : lanes.map((lane) => ({ lane, value: valueAtFraction(lane, cross!.frac) })),
  );
</script>

<div class="gp-chartwrap">
  <svg
    class="gp-hero"
    viewBox="0 0 740 360"
    role="img"
    aria-label="Plan usage against the share of each connection's own window elapsed"
    onmousemove={onMove}
    onmouseleave={() => (cross = null)}
  >
    <g class="gp-grid">
      {#each [0, 25, 50, 75, 100] as p (p)}
        <line x1={L} y1={y(p)} x2={R} y2={y(p)} />
      {/each}
    </g>
    <g class="gp-ax">
      {#each [0, 25, 50, 75, 100] as p (p)}
        <text x={L - 8} y={y(p) + 3.5} text-anchor="end">{p}%</text>
      {/each}
    </g>

    <!-- The ONLY grey line in the chart. On a fraction axis the even burn is the
         same diagonal for every window, which is why the axis was normalised. -->
    <line class="gp-fair" x1={L} y1={y(0)} x2={R} y2={y(100)} />
    <text class="gp-fairlabel" x={x(0.62)} y={y(62) + 15}>fair pace (even burn)</text>

    {#each drawn as d (d.lane.providerId + d.lane.label)}
      <g
        class="gp-lanegroup"
        class:gp-dim={dim(d.lane.providerId)}
        role="presentation"
        onmouseenter={() => onHighlight(d.lane.providerId)}
        onmouseleave={() => onHighlight(null)}
      >
        <path class="gp-lead" d={d.lead} stroke={d.lane.colour} fill="none" />
        <path class="gp-line" d={d.curve} stroke={d.lane.colour} fill="none" />
        {#if d.projection}
          <path
            class="gp-proj"
            class:gp-proj-prov={d.lane.projection?.basis === 'provisional'}
            d="M{d.end.x.toFixed(2)},{d.end.y.toFixed(2)}L{d.projection.to.x.toFixed(2)},{d.projection.to.y.toFixed(2)}"
            stroke={d.lane.colour}
            fill="none"
          />
          {#if d.projection.capped}
            <circle class="gp-capdot" cx={d.projection.to.x} cy={d.projection.to.y} r="3" fill={d.lane.colour} />
          {/if}
        {/if}
        <circle class="gp-enddot" cx={d.end.x} cy={d.end.y} r="4" fill={d.lane.colour} />
      </g>
    {/each}

    {#each labels as it (it.lane.providerId + it.lane.label)}
      <g class="gp-labelgroup" class:gp-dim={dim(it.lane.providerId)}>
        <path class="gp-leader" d="M{it.x.toFixed(2)},{it.y.toFixed(2)}L{it.lx.toFixed(2)},{it.ly.toFixed(2)}" stroke={it.lane.colour} fill="none" />
        <text class="gp-endlab" x={it.lx.toFixed(2)} y={(it.ly + 3.5).toFixed(2)} text-anchor={it.anchor} fill={it.lane.colour}>
          {it.lane.name} {it.lane.usedPct.toFixed(1)}%
        </text>
      </g>
    {/each}

    <!-- The single end-of-window wall every connection runs toward. -->
    <line class="gp-reset" x1={R} y1={TOP - 18} x2={R} y2={BOT + 6} />
    <rect class="gp-resetchip" x={R - 44} y={TOP - 34} width="44" height="15" rx="3" />
    <text class="gp-resetchiptext" x={R - 22} y={TOP - 23} text-anchor="middle">RESET</text>

    <line class="gp-base" x1={L} y1={BOT + 6} x2={R} y2={BOT + 6} />
    <g class="gp-dl">
      {#each [0, 25, 50, 75, 100] as p (p)}
        <text x={x(p / 100)} y={BOT + 20} text-anchor={p === 0 ? 'start' : p === 100 ? 'end' : 'middle'}>{p}%</text>
      {/each}
    </g>
    <!-- The RESERVED note band. Nothing else is ever drawn at this height, so a
         label the collision pass pushed to the bottom cannot land on it. -->
    <text class="gp-note" x={L} y={BOT + 36}>{coverageNote}</text>
    {#if guardNote}
      <text class="gp-guardnote" x={R} y={BOT + 36} text-anchor="end">{guardNote}</text>
    {/if}
    <text class="gp-axcaption" x={(L + R) / 2} y={BOT + 50} text-anchor="middle">share of each connection’s own window elapsed</text>

    {#if cross}
      <line class="gp-cross" x1={x(cross.frac)} y1={TOP - 6} x2={x(cross.frac)} y2={BOT + 4} />
    {/if}
  </svg>

  {#if cross}
    <div class="gp-tip" style="left:{Math.min(78, Math.max(2, (cross.px / 740) * 100 + 2))}%; top:{Math.max(0, (cross.py / 360) * 100 - 4)}%">
      <div class="gp-tip-h">{Math.round(cross.frac * 100)}% of window</div>
      {#each readings as r (r.lane.providerId + r.lane.label)}
        <span class="gp-tip-r">
          <i style="background:{r.lane.colour}"></i>{r.lane.name}
          <b>{r.value === undefined ? 'no reading' : `${r.value.toFixed(1)}%`}</b>
        </span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .gp-chartwrap { position: relative; }
  .gp-hero { width: 100%; height: auto; display: block; overflow: visible; }
  .gp-grid line { stroke: var(--og-border); }
  .gp-ax text { fill: var(--og-text-muted); font-size: 10px; }
  .gp-dl text { fill: var(--og-text-muted); font-size: 9.5px; }
  .gp-base { stroke: var(--og-border); }
  .gp-fair { stroke: var(--og-text-muted); stroke-width: 1; stroke-dasharray: 6 5; }
  .gp-fairlabel { fill: var(--og-text-muted); font-size: 10px; }
  .gp-note { fill: var(--og-text-muted); font-size: 9.5px; }
  .gp-guardnote { fill: var(--og-text-muted); font-size: 9.5px; }
  .gp-axcaption { fill: var(--og-text-muted); font-size: 9.5px; }
  .gp-reset { stroke: var(--og-text); stroke-width: 2.5; }
  .gp-resetchip { fill: var(--og-text); }
  .gp-resetchiptext { fill: var(--og-surface); font-size: 8.5px; font-weight: bold; }
  .gp-lead { stroke-width: 1; opacity: 0.45; stroke-dasharray: 2 4; }
  .gp-line { stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
  .gp-proj { stroke-width: 1.8; opacity: 0.75; stroke-dasharray: 5 4; }
  /* Same dash as a firm projection, drawn thinner in ink. Matches the mini
     card, so one connection cannot look firmer in one place than the other. */
  .gp-proj.gp-proj-prov { opacity: 0.35; }
  .gp-enddot, .gp-capdot { stroke: var(--og-surface); stroke-width: 2; }
  .gp-leader { stroke-width: 1; opacity: 0.5; }
  .gp-endlab { font-size: 9.5px; font-weight: 600; }
  .gp-cross { stroke: var(--og-text-muted); stroke-width: 1; stroke-dasharray: 2 3; }
  /* The bunched-lines rule: one connection at full strength, the rest faded far
     enough to read past but not so far they vanish and change the shape. */
  .gp-lanegroup, .gp-labelgroup { transition: opacity 90ms linear; }
  .gp-dim { opacity: 0.25; }

  .gp-tip { position: absolute; pointer-events: none; background: var(--og-surface-alt); border: 1px solid var(--og-border); border-radius: 6px; padding: 7px 9px; font-size: 11px; color: var(--og-text-secondary); display: flex; flex-direction: column; gap: 2px; white-space: nowrap; z-index: 2; }
  .gp-tip-h { font-size: 9.5px; text-transform: uppercase; letter-spacing: 1px; color: var(--og-text-muted); margin-bottom: 2px; }
  .gp-tip-r { display: flex; align-items: center; gap: 6px; }
  .gp-tip-r i { width: 8px; height: 8px; border-radius: 2px; flex: none; }
  .gp-tip-r b { color: var(--og-text); margin-left: auto; padding-left: 10px; }
</style>
