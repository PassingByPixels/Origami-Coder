// The exported atlas's CHROME — everything around the map: run content escaping,
// the kind filter row, the pinned inspector rail and the ledger drawer.
//
// Extracted from labyrinthHtml.ts rather than grown into it: the page went from
// a document (heading, picture, table) to a console (header, filters, two panes,
// a drawer), and that file has an architecture cap it would have blown through
// three times over. labyrinthHtml.ts now only ASSEMBLES what this module, the
// strip and the ledger produce.
//
// Two rules carried verbatim from the document version, both load-bearing:
//
//  1. Every value that came from run content goes through `esc` on its way into
//     markup, so a step titled `<script>` is a string in a cell and nothing
//     else. The interactive layer receives the same content as JSON-escaped
//     DATA and writes it with `textContent` (labyrinthReport.ts) — this file
//     never builds an element from run content and never hands one to a sink.
//  2. No literal colour. The kind swatches take their hue from labyrinthTone.ts,
//     which is the SAME table the map's markers are toned from, and every value
//     here is resolved against the live root by labyrinthExport.ts.

import { isThreshold, type LaneStep } from './labyrinthLanes';
import { toneVar } from './labyrinthTone';

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/** Run content -> safe text. `undefined` prints as nothing, and 0 prints as 0. */
export function esc(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * The filter row. Offered only where it can act: the kinds are the kinds this
 * run actually HAS, each carrying its own count, and "Failures only" appears
 * only when the run has a failure — a filter that could only ever empty the map
 * is a trap. "All steps" stays the explicit way back, rather than making the
 * reader guess that re-clicking the active chip undoes it.
 */
export function filterBar(steps: readonly LaneStep[]): string {
  const counts = new Map<string, number>();
  for (const s of steps) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const failures = steps.filter(isThreshold).length;

  const chips: string[] = [chip('', 'All steps', undefined, undefined, true)];
  if (failures > 0) chips.push(chip('!', 'Failures only', failures, undefined, false));
  for (const [kind, n] of counts) chips.push(chip(`k:${kind}`, kind, n, toneVar(kind), false));
  return `<div class="filters" id="og-filters">${chips.join('')}</div>`;
}

function chip(spec: string, label: string, n: number | undefined, tone: string | undefined, on: boolean): string {
  const sw = tone ? `<span class="sw" style="background:${tone}"></span>` : '';
  const count = n === undefined ? '' : `<span class="n">${n.toLocaleString()}</span>`;
  return `<button type="button" data-filter="${esc(spec)}" aria-pressed="${on}">${sw}${esc(label)}${count}</button>`;
}

/** The filter row plus the control that pulls the ledger up. */
export function toolsRow(steps: readonly LaneStep[]): string {
  return `<div class="tools">${filterBar(steps)}<span class="spacer"></span>`
    + '<button type="button" id="og-drawer-toggle" aria-pressed="false">Show step ledger</button></div>';
}

/** The inspector rail — permanent, never covering the map, never moving. */
export function railWrap(panel: string): string {
  return '<aside class="railwrap"><div class="rail-bar"><span class="dotmark"></span>Inspector — pinned</div>'
    + `${panel}</aside>`;
}

/**
 * The ledger, DEMOTED. It is the printable record and it stays complete, but a
 * run report's first screen is the run, not a table of it — so it opens on
 * demand and closes again without losing the reader's place on the map.
 */
export function drawer(rows: number, table: string): string {
  return '<div class="drawer" id="og-drawer" hidden>'
    + `<div class="dw-bar">Step ledger — ${rows.toLocaleString()} row${rows === 1 ? '' : 's'}`
    + '<button type="button" id="og-drawer-close">Close</button></div>'
    + `${table}</div>`;
}

/**
 * The drawer's behaviour, appended to the report painter INSIDE the same script
 * block — the page ships exactly two script elements (the JSON data and the
 * painter), and a third would mean run content had opened an executable region
 * of its own. That count is asserted.
 */
export const ATLAS_JS = `
(function () {
  var drawer = document.getElementById('og-drawer');
  var toggle = document.getElementById('og-drawer-toggle');
  var close = document.getElementById('og-drawer-close');
  if (!drawer || !toggle) { return; }
  function setOpen(on) {
    drawer.hidden = !on;
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    toggle.textContent = on ? 'Hide step ledger' : 'Show step ledger';
  }
  toggle.addEventListener('click', function () { setOpen(drawer.hidden); });
  if (close) { close.addEventListener('click', function () { setOpen(false); }); }
})();
`;
