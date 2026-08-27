// Agent Manager - mapHtml.ts (S15): render a validated RepoMap to a SELF-CONTAINED
// static HTML artifact (.origami/map/map.html), written on a successful map run so
// the human view survives outside VS Code — open the file in any browser, offline,
// forever. Inline CSS + the map JSON embedded + one inline script. NO external
// asset of any kind: no font, no stylesheet, no image, no script file, and no
// `http`/`https` string anywhere in the document (the guard test asserts that
// literally, over the whole file).
//
// The artifact is the FLOW-SPINE isometric drawing (Passing's pick of the
// cartographer mockups): a slim header, a filter rail on the left, the picture in
// the middle, and a rail on the right carrying the repository summary, the flows
// and whatever is selected. Both rails drag to resize and fold away entirely, so
// the map can have the whole window.
//
// THIS FILE ONLY ASSEMBLES. The geometry is isoLayout.ts's (shared verbatim with
// the in-editor screen, so the two pictures cannot drift), the picture is
// mapHtmlSvg.ts + mapHtmlWires.ts's, the sheets are mapHtmlCss.ts +
// mapHtmlDrawCss.ts's and the behaviour is mapHtmlScript.ts + mapHtmlRails.ts's.
// Splitting them is what let the assembler stay inside its original cap while the
// artifact grew rails. Pure + vscode-free, so it unit-tests as string in, string out.

import type { IsoLayout } from './isoLayout';
import { layoutMap } from './isoLayout';
import { MAP_CSS } from './mapHtmlCss';
import { MAP_DRAW_CSS } from './mapHtmlDrawCss';
import { MAP_JS } from './mapHtmlScript';
import { esc, isoSvg, pillarName } from './mapHtmlSvg';
import { colourOf, FLOW_COLOR, KIND_COLOR, kindsIn, PILLAR_COLOR } from './mapPalette';
import { PILLARS, type RepoMap } from './mapSchema';

/** The kind legend: a swatch, the kind, and how many components carry it. Built
 *  from the kinds the map ACTUALLY uses, not from the palette's own list — `kind`
 *  is a free string in the schema, so a map may name one this table never heard
 *  of, and a legend that omitted it would under-count the picture it labels. */
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

/** The header: what this is, how big it is, and the view controls. NO thesis and
 *  no schema note — the mockup carried both to explain itself to a reviewer, and
 *  a shipped artifact explains the REPOSITORY, not the drawing. */
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

/** The payload the inline script reads. Only the fields the panels show — the
 *  geometry is already in the server-rendered SVG, so re-sending it would double
 *  the file for nothing. Every `<` becomes \\u003c, which is what makes a
 *  `</script>` inside a node name unable to close the tag it sits in. */
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
