// The map exported AS A PAGE — one self-contained .html carrying the picture
// and the data it drops. This file ASSEMBLES it; the parts live in
// labyrinthAtlasCss.ts (layout), labyrinthStrip.ts (spend), labyrinthAtlas.ts
// (chrome), labyrinthLedger.ts (the table) and labyrinthReport.ts (the
// interactive layer).
//
// THE MAP IS NOT REDRAWN HERE. `doc.svg` is the very picture the Thread view
// rendered, serialized by labyrinthExport.ts, so branches, the clock axis,
// collision avoidance and threshold marks all arrive by construction. An
// exporter that painted its own braid would be a second geometry to keep in
// step. Pinned by labyrinthAtlas.test.ts, which asserts the artifact's
// coordinates against the pure layout modules.
//
// SELF-CONTAINED is the contract: no stylesheet, script file, font or image
// is fetched, since a saved artifact opens off a file:// URL with the
// network gone.
//
// HONESTY, carried over from the pane: a TRUNCATED run says so; an absent
// field renders empty, never "undefined" or a fabricated 0; and every value
// from run content is escaped.
//
// No literal colour lives here either: the CSS uses `var(--og-*)` terms,
// resolved by labyrinthExport.ts against the running document, so the
// theme-discipline guard covers this file too.

import { ATLAS_JS, drawer, esc, railWrap, toolsRow } from './labyrinthAtlas';
import { ATLAS_CSS } from './labyrinthAtlasCss';
import { resolveThemeVars, type VarReader } from './labyrinthExport';
import { ledgerTable } from './labyrinthLedger';
import { REPORT_CSS, REPORT_JS, REPORT_PANEL, stepsJson, type HtmlStep } from './labyrinthReport';
import { usageStrip } from './labyrinthStrip';

export type { HtmlStep };

export interface LabyrinthDoc {
  mode: string;
  /** The map, already standalone — see labyrinthExport.ts. */
  svg: string;
  /** The steps the map DREW, which is what the table must list. */
  steps: readonly HtmlStep[];
  /** How many the engine returned — the truncation notice's numerator. */
  loaded: number;
  truncated: boolean;
  total: number;
  title?: string;
  folder?: string;
  when?: string;
}

/** An unparseable timestamp prints as nothing, never as "Invalid Date". */
function whenLabel(iso: string | undefined): string {
  const t = iso === undefined ? NaN : Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : '';
}

// The one cross-product line in the artifact: a link to Origami Folio, not
// a tracker (zero-network). No print-hide: the export test forbids
// display:none anywhere, since hidden content in a saved page is deception.
const FOLIO_AD_CSS = '.folio-ad{position:fixed;top:10px;right:12px;z-index:60;font-size:11px;padding:4px 10px;'
  + 'border-radius:999px;background:var(--og-surface);border:1px solid var(--og-border);'
  + 'color:var(--og-text-secondary);text-decoration:none}'
  + '.folio-ad:hover{color:var(--og-text);border-color:var(--og-chat)}';
const FOLIO_AD = '<a class="folio-ad" href="https://chromewebstore.google.com/detail/origami-folio/flhbdfakcooaomfaehhgenmmnlglhehk" target="_blank" rel="noopener">'
  + 'Want Office Free in your browser? Try Origami Folio</a>';

/**
 * The whole artifact. `vars` reads `--og-*` off the live document root, so
 * every colour came from the theme the map was drawn under.
 */
export function labyrinthHtmlDoc(doc: LabyrinthDoc, vars: VarReader): string {
  const heading = doc.title?.trim() ? doc.title : 'Labyrinth map';
  const meta = [doc.folder, whenLabel(doc.when), `${doc.mode} view`, `${doc.steps.length.toLocaleString()} steps`]
    .filter((part) => !!part && String(part).trim() !== '')
    .map((part) => `<span>${esc(part)}</span>`)
    .join('');
  // Word for word the pane's own notice, because it is the same claim.
  const warn = doc.truncated
    ? `<p class="warn">Showing the first ${doc.loaded.toLocaleString()} of ${doc.total.toLocaleString()} steps — `
      + "this run is truncated by the engine's step cap. The map and table below are a PREFIX, "
      + 'not the whole run.</p>'
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)} — Labyrinth ${esc(doc.mode)}</title>
<style>${resolveThemeVars(ATLAS_CSS + REPORT_CSS + FOLIO_AD_CSS, vars)}</style>
</head>
<body>
${FOLIO_AD}
<div class="app">
<header>
<div class="hrow"><span class="brand">Origami / Labyrinth</span><h1>${esc(heading)}</h1>
<span class="meta">${meta}</span></div>
${warn}
${resolveThemeVars(usageStrip(doc.steps, doc.truncated), vars)}
</header>
${resolveThemeVars(toolsRow(doc.steps), vars)}
<main><div class="mapwrap"><div id="og-map">${doc.svg}</div></div>
${railWrap(REPORT_PANEL)}</main>
${drawer(doc.steps.length, ledgerTable(doc.steps))}
</div>
<script type="application/json" id="og-steps">${stepsJson(doc.steps)}</script>
<script>${REPORT_JS}${ATLAS_JS}</script>
</body>
</html>
`;
}
