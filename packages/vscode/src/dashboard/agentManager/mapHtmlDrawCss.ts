// The static map.html DRAWING sheet: the stage, the solids, the connectors, the
// labels and the hover card. Split from mapHtmlCss.ts (the page around it) when
// the artifact became the flow-spine picture — the page changes when a control
// moves, the drawing changes when the visual language does, and neither should
// force the other's file past its cap.
//
// FACE COLOURS ARE NOT HERE. A box is coloured by its `kind` and shaded per face,
// so the three fills are computed per node in mapHtmlSvg.ts from mapPalette.ts
// and written inline. Only the things that are the same for every solid — stroke
// joins, the badge, the caption's halo — live in this sheet.
//
// `paint-order: stroke` on every label is what makes a caption readable over a
// solid: the text is stroked in the ground colour FIRST and filled second, so it
// carries its own halo instead of needing a rectangle behind it.

export const MAP_DRAW_CSS = `
  .stage-wrap { position: relative; overflow: hidden; flex: 1; min-width: 0;
    background: radial-gradient(circle at 50% 40%, rgba(56, 189, 248, 0.05), transparent 60%); }
  svg#stage { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
  svg#stage.grabbing { cursor: grabbing; }
  .hint { position: absolute; left: 12px; bottom: 9px; font-size: 10px; color: #64748b;
    pointer-events: none; letter-spacing: 0.03em; }
  .node { cursor: pointer; }
  .node polygon { stroke-linejoin: round; }
  .node.sel polygon.top { stroke: #fff; stroke-width: 1.6; }
  .node.dim { opacity: 0.13; }
  /* Filtered OUT, not merely faded: a search or a kind toggle removes the box and
     its caption from the picture. A class, never the hidden ATTRIBUTE — that one
     is HTML-only content and does nothing at all to an SVG element. */
  .hide { display: none; }
  text.badge { font-size: 9px; font-weight: 700; fill: #0b1220; text-anchor: middle;
    dominant-baseline: middle; pointer-events: none; letter-spacing: 0.03em; }
  text.caption { font-size: 8.5px; fill: #cbd5e1; text-anchor: middle; pointer-events: none;
    paint-order: stroke; stroke: #0b1220; stroke-width: 2.6px; stroke-linejoin: round; }
  text.zlab { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    pointer-events: none; paint-order: stroke; stroke: #0b1220; stroke-width: 3px; stroke-linejoin: round; }
  text.zsub { font-size: 9px; fill: #64748b; pointer-events: none; paint-order: stroke;
    stroke: #0b1220; stroke-width: 2.6px; stroke-linejoin: round; }
  text.slab { font-size: 9px; font-weight: 600; fill: #94a3b8; letter-spacing: 0.04em; text-anchor: middle;
    pointer-events: none; paint-order: stroke; stroke: #0b1220; stroke-width: 2.6px; stroke-linejoin: round; }
  text.stepn { font-size: 9px; font-weight: 700; fill: #0b1220; text-anchor: middle;
    dominant-baseline: middle; pointer-events: none; }
  path.link { fill: none; stroke: #8095ad; stroke-width: 1.3; opacity: 0.48; }
  polygon.tip { fill: #8095ad; opacity: 0.55; }
  .lk.hot path.link { stroke: #38bdf8; stroke-width: 2.4; opacity: 1; }
  .lk.hot polygon.tip { fill: #38bdf8; opacity: 1; }
  .lk.dim { opacity: 0.13; }
  path.flowline { fill: none; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; opacity: 0.95; }
  text.elab { font-size: 8.5px; fill: #38bdf8; text-anchor: middle; font-weight: 600; pointer-events: none;
    paint-order: stroke; stroke: #0b1220; stroke-width: 2.6px; stroke-linejoin: round; }
  /* Every flow trace and every edge label is rendered ONCE, up front, and shown by
     class — the inline script builds no SVG at all. Building one at runtime needs
     a namespaced element factory, and the URL that factory takes would be the only
     one anywhere in a document whose whole contract is that it fetches nothing.
     The reasoning in full is in mapHtmlWires.ts, which does not ship to the page. */
  .trace, text.elab { display: none; }
  .trace.on, text.elab.on { display: inline; }
  .noedges #links { display: none; }
  .nonames #names { display: none; }
  #tip { position: absolute; pointer-events: none; z-index: 40; max-width: 290px; background: #0f172a;
    border: 1px solid #334155; border-radius: 7px; padding: 8px 10px; font-size: 11px; line-height: 1.45;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55); display: none; }
  #tip.on { display: block; }
  #tip .t-name { font-weight: 600; font-size: 12px; margin-bottom: 3px; }
  #tip .t-meta { font-size: 10px; color: #94a3b8; margin-bottom: 5px; }
  #tip .t-sum { color: #cbd5e1; }
  #tip .t-path { font-family: var(--mono); font-size: 10px; color: #64748b; margin-top: 5px; word-break: break-all; }
`;
