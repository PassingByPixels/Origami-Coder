// Renders a validated RepoMap to a self-contained static HTML artifact
// (.origami/map/map.html), written on a successful map run so the human view survives
// outside VS Code — no external asset, font, script, or `http(s)` string anywhere (a guard
// test asserts this over the whole file). This file only assembles: geometry from
// isoLayout.ts (shared with the in-editor screen so the two pictures can't drift), the
// picture/sheets/behaviour split across mapHtmlSvg/Wires/Css/DrawCss/Script/Rails.ts.

import type { IsoLayout } from './isoLayout';
import { layoutMap } from './isoLayout';
import { MAP_CSS } from './mapHtmlCss';
import { MAP_DRAW_CSS } from './mapHtmlDrawCss';
import { MAP_JS } from './mapHtmlScript';
import { esc, isoSvg, pillarName } from './mapHtmlSvg';
import { colourOf, FLOW_COLOR, KIND_COLOR, kindsIn, PILLAR_COLOR } from './mapPalette';
import { PILLARS, type RepoMap } from './mapSchema';

/** The kind legend, built from the kinds the map actually uses (not the palette's own list)
 *  since `kind` is a free string in the schema. */
function legendHtml(map: RepoMap): string {
  const counts = new Map<string, number>();
  for (const n of map.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  return kindsIn(counts.keys()).map((k) =>
    `<button class="legend-item" data-kind="${esc(k)}" type="button">`
    + `<span class="cube" style="background:${colourOf(k)}"></span>${esc(k)}`
    + `<span class="n">${counts.get(k) ?? 0}</span></button>`).join('');
}

function pillarsHtml(map: RepoMap): string {
  const counts = new Map<number, number>();
  for (const n of map.nodes) counts.set(n.pillar, (counts.get(n.pillar) ?? 0) + 1);
  return PILLARS.map((p) =>
    `<li data-pillar="${p.number}" style="border-left-color:${PILLAR_COLOR[p.number]}">`
    + `${p.number} · ${esc(p.name)} <span class="n">${counts.get(p.number) ?? 0}</span></li>`).join('');
}

function flowsHtml(map: RepoMap): string {
  if (map.flows.length === 0) return '<p class="prose">This map records no flows.</p>';
  return map.flows.map((f, i) =>
    `<button class="flow-btn" data-flow="${esc(f.id)}" style="border-left-color:${FLOW_COLOR[i % FLOW_COLOR.length]}">`
    + `<span class="fid">${esc(f.id)}</span>${esc(f.name)}</button>`).join('');
}

/** The header: what this is, how big, view controls — no thesis or schema note, since a
 *  shipped artifact explains the repository, not the drawing. */
function headHtml(map: RepoMap, layout: IsoLayout): string {
  const built = map.builtAt
    ? `${esc(map.builtAt.branch)} @ ${esc(map.builtAt.sha.slice(0, 7))} · ${new Date(map.builtAt.at).toISOString().slice(0, 10)}`
    : 'unstamped';
  return `<header><h1>${esc(map.name)}<span class="sub">${layout.boxes.length} components · `
    + `${map.edges.length} links · ${map.flows.length} flows · ${built}</span></h1>`
    + `<div class="tools">`
    + `<button class="btn on" id="btn-left" type="button">Filters</button>`
    + `<button class="btn" id="btn-fit" type="button">Fit</button>`
    + `<button class="btn" id="btn-reset" type="button">Reset</button>`
    + `<button class="btn" id="btn-labels" type="button">Names: auto</button>`
    + `<button class="btn on" id="btn-edges" type="button">Edges</button>`
    + `<button class="btn on" id="btn-right" type="button">Details</button>`
    + `</div></header>`;
}

/** The payload the inline script reads: only the fields the panels show, since the geometry
 *  is already in the server-rendered SVG. Every `<` is escaped so a `</script>` can't close
 *  inside a node name. */
function payload(map: RepoMap, layout: IsoLayout): string {
  const pillars: Record<number, string> = {};
  for (const p of PILLARS) pillars[p.number] = pillarName(p.number);
  const kinds: Record<string, string> = { ...KIND_COLOR };
  for (const n of map.nodes) kinds[n.kind] = colourOf(n.kind);
  const data = {
    name: map.name,
    summary: map.summary,
    pillars,
    kinds,
    flowColours: FLOW_COLOR,
    nodes: layout.boxes.map((b) => ({
      id: b.id, name: b.name, kind: b.kind, path: b.path,
      summary: b.summary, status: b.status, section: b.section, pillar: b.pillar,
    })),
    edges: map.edges,
    flows: map.flows,
    keyFiles: map.keyFiles ?? [],
    conventions: map.conventions ?? [],
    view: layout.view,
  };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** Render a validated map to a standalone HTML document string. */
export function renderMapHtml(map: RepoMap): string {
  const layout = layoutMap(map);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(map.name)} - architecture map</title>
<style>${MAP_CSS}${MAP_DRAW_CSS}</style>
</head>
<body>
${headHtml(map, layout)}
<div class="app" id="app">
  <aside class="rail-l" id="rail-l">
    <div><div class="stitle">Find a component</div>
      <input class="search" id="search" placeholder="name, path, summary&hellip;" /></div>
    <div><div class="stitle">Kind &mdash; click to filter</div>${legendHtml(map)}
      <div class="edge-legend">
        <div><i style="background:#8095ad"></i><span>static dependency</span></div>
        <div><i style="background:#38bdf8"></i><span>selected connection</span></div>
      </div></div>
    <div><div class="stitle">Pillars &mdash; click to filter</div>
      <ul class="pillar-list">${pillarsHtml(map)}</ul></div>
  </aside>
  <button class="grip" id="grip-l" type="button" aria-label="Resize the filter rail"></button>
  <main class="stage-wrap" id="stage-wrap">${isoSvg(layout, map)}<div id="tip"></div>
    <div class="hint">drag to pan &middot; wheel to zoom &middot; click a box for its connections &middot; click a flow to trace it</div>
  </main>
  <button class="grip" id="grip-r" type="button" aria-label="Resize the detail rail"></button>
  <aside class="rail-r" id="rail-r">
    <div><div class="stitle">Repository</div>
      <p class="prose">${esc(map.summary)}</p></div>
    <div><div class="stitle">Flows &mdash; click to trace</div>${flowsHtml(map)}</div>
    <div id="detail"></div>
  </aside>
</div>
<script>
var MAP = ${payload(map, layout)};
${MAP_JS}
</script>
</body>
</html>`;
}
