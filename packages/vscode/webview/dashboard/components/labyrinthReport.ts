// The exported page's INTERACTIVE layer — what turns the artifact from a
// picture plus a table into a report you can interrogate.
//
// Owner's UAT: "click a node and you get the stream's information". So the
// file carries the per-step detail as DATA and a small inline script that
// renders it on click. Extracted rather than grown into labyrinthHtml.ts,
// which had 23 lines left under its cap.
//
// Two safety properties are load-bearing and neither is negotiable:
//
//  1. SELF-CONTAINED still means self-contained. The script is INLINE — no
//     src, no stylesheet, no font, no image — so the page is identical off a
//     file:// URL with the network gone.
//  2. Run content is arbitrary model output, so it is never markup. The JSON
//     block escapes every `<` and `>`, which is what stops a step titled
//     `</script>` from closing the block and running the rest of the title as
//     script; and every value reaches the DOM through `textContent`, which is
//     what stops `<img onerror=...>` from becoming a live element. Both are
//     asserted with exactly those payloads in labyrinthHtml.test.ts.
//
// The rendered VALUES are all computed here, server-side, off the same helpers
// the table uses — so the detail panel and the ledger can never disagree, and
// the inline script stays a dumb painter with no formatting rules of its own.
//
// No literal colour lives here: the CSS is written in `var(--og-*)` terms and
// resolved by labyrinthExport.ts against the live root, same as the map.

import { formatClock, formatDuration } from './labyrinthFormat';
import { isThreshold } from './labyrinthLanes';
import { stepUsageText, type UsageStep } from './labyrinthUsage';

/**
 * The step fields the report prints — `UsageStep` (ordinal, kind, title,
 * status, agent, tokens, cost, depth, parentOrdinal) plus the few the export
 * renders that the usage rules have no use for.
 *
 * Extending rather than restating it is deliberate: the usage bag is growing
 * (reasoning, cache, cost) and a private copy of its shape here would drift
 * silently. Every one of those fields is OPTIONAL, so an export stays correct
 * against a run carrying only `{input, output}` or no tokens at all.
 */
export interface HtmlStep extends UsageStep {
  tool?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  model?: string;
  preview?: string;
  error?: string;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 0 is the main thread, not a sub-agent level — so it is an ABSENCE here. */
export function subDepth(s: HtmlStep): number | undefined {
  return num(s.depth) && s.depth > 0 ? Math.floor(s.depth) : undefined;
}

/** The ordinal this step branched off, as the table and the panel both print it. */
export function branchOf(s: HtmlStep): string | undefined {
  return num(s.parentOrdinal) ? `#${s.parentOrdinal}` : undefined;
}

/** The ledger column: both halves or nothing, so a half-measured pair cannot read as a total. */
export function tokensCell(s: HtmlStep): string | undefined {
  const t = s.tokens;
  return t && num(t.input) && num(t.output) ? `${t.input} / ${t.output}` : undefined;
}

/** One step as the inline painter consumes it: a head, a title and earned rows. */
interface ReportStep {
  o: number; kind: string; title: string; fail?: 1; rows: Array<[string, string]>;
}

function detail(s: HtmlStep): ReportStep {
  const rows: Array<[string, string]> = [];
  // Absent contributes NO row — but a genuine 0 is a measurement and stays.
  const add = (label: string, value: string | number | undefined): void => {
    if (value === undefined || value === '') return;
    rows.push([label, String(value)]);
  };
  add('Tool', s.tool);
  add('Status', s.status);
  add('Started', formatClock(s.startedAt));
  add('Ended', formatClock(s.endedAt));
  add('Duration', formatDuration(s.durationMs));
  // The inspector's OWN usage line, not a second copy of the formatting rules —
  // the exported report and the pane must never disagree about a run's cost.
  add('Tokens', stepUsageText(s));
  add('Model', s.model);
  add('Agent', s.agent);
  add('Sub-agent depth', subDepth(s));
  add('Branch of', branchOf(s));
  add('Preview', s.preview);
  add('Error', s.error);
  const out: ReportStep = { o: s.ordinal, kind: s.kind, title: s.title, rows };
  if (isThreshold(s)) out.fail = 1;
  return out;
}

/**
 * The step data, safe to sit inside a <script> block.
 *
 * `<` and `>` become JSON unicode escapes, so `</script>`, `<script` and
 * `<!--` in run content are all inert: the parser sees no tag-ish sequence,
 * and JSON.parse hands the ORIGINAL characters back to be set as text.
 */
export function stepsJson(steps: readonly HtmlStep[]): string {
  return JSON.stringify(steps.map(detail)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/**
 * The panel's resting state — the page says what to do before it is clicked.
 * It sits in the atlas's pinned rail (labyrinthAtlas.ts wraps it), so the copy
 * names both surfaces a reader can click and says the rail will stay put.
 */
export const REPORT_PANEL =
  '<div class="detail" id="og-detail"><p class="dt-idle">Select a step — click any node on the map, '
  + 'or any row in the ledger drawer — and everything it recorded lands here. '
  + 'The rail stays put while you work across the map.</p></div>';

// The atlas owns LAYOUT (labyrinthAtlasCss.ts): the filter row, the rail and
// the drawer are its furniture. What stays here is the per-step detail's own
// typography and the two selection rules, which belong with the painter.
export const REPORT_CSS = `
.dt-idle { margin: 0; color: var(--og-text-muted); font-style: italic; line-height: 1.6; }
.dt-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 3px; }
.dt-kind { font-size: 9px; text-transform: uppercase; letter-spacing: 0.14em; font-weight: 700; color: var(--og-chat); }
.dt-ord { font-size: 11px; color: var(--og-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dt-fail { font-size: 9px; letter-spacing: 0.1em; font-weight: 700; color: var(--og-error-text);
  background: var(--og-error-soft); border: 1px solid var(--og-error); padding: 0 6px; border-radius: 8px; }
.dt-title { font-weight: 600; font-size: 14px; margin: 0 0 13px; line-height: 1.4;
  word-break: break-word; color: var(--og-text); }
.dt-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; font-size: 12px; }
.dt-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); padding-top: 3px; }
.dt-value { color: var(--og-text-secondary); word-break: break-word; overflow-wrap: anywhere; }
.dt-pre { white-space: pre-wrap; color: var(--og-text); background: var(--og-bg); padding: 9px 10px;
  border-radius: 5px; border: 1px solid var(--og-border);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.dt-err { white-space: pre-wrap; color: var(--og-error); }
/* The map's own presentation is INLINE (labyrinthExport.ts collapses the scoped
   cascade onto each element), so selection and dimming have to out-rank it. */
#og-map [data-og-sel] > circle { stroke: var(--og-text) !important; stroke-width: 2.6 !important; stroke-opacity: 1 !important; }
#og-map [data-og-dim] { opacity: 0.14 !important; }
#og-ledger tbody tr { cursor: pointer; }
#og-ledger tr[data-og-sel] { background: var(--og-surface-alt); }
#og-ledger tr[data-og-sel] td { color: var(--og-text); }
`;

/**
 * The painter. Every string it writes goes in via `textContent`, so a preview
 * full of markup is shown, not run. It reads formatted values only — there is
 * no date or duration logic in here to drift from the ledger's.
 */
export const REPORT_JS = `
(function () {
  var raw = document.getElementById('og-steps');
  var STEPS = JSON.parse((raw && raw.textContent) || '[]');
  var byOrd = {};
  STEPS.forEach(function (s) { byOrd[String(s.o)] = s; });
  var panel = document.getElementById('og-detail');
  var rows = [].slice.call(document.querySelectorAll('#og-ledger tbody tr'));
  var nodes = [].slice.call(document.querySelectorAll('#og-map [data-ordinal]'));
  var btns = [].slice.call(document.querySelectorAll('#og-filters button'));
  var picked = null;

  function put(parent, cls, text) {
    var el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    parent.appendChild(el);
    return el;
  }
  function flag(el, name, on) {
    if (on) { el.setAttribute(name, '1'); } else { el.removeAttribute(name); }
  }
  function show(ord) {
    var s = byOrd[String(ord)];
    if (!s) { return; }
    picked = String(ord);
    panel.textContent = '';
    var head = put(panel, 'dt-head', '');
    put(head, 'dt-kind', s.kind);
    put(head, 'dt-ord', '#' + s.o);
    if (s.fail === 1) { put(head, 'dt-fail', 'FAILED'); }
    put(panel, 'dt-title', s.title);
    var grid = put(panel, 'dt-grid', '');
    s.rows.forEach(function (r) {
      put(grid, 'dt-label', r[0]);
      put(grid, r[0] === 'Error' ? 'dt-value dt-err' : r[0] === 'Preview' ? 'dt-value dt-pre' : 'dt-value', r[1]);
    });
    rows.forEach(function (el) { flag(el, 'data-og-sel', el.getAttribute('data-ordinal') === picked); });
    nodes.forEach(function (el) { flag(el, 'data-og-sel', el.getAttribute('data-ordinal') === picked); });
  }
  function keeps(s, spec) {
    if (!s || !spec) { return true; }
    return spec === '!' ? s.fail === 1 : s.kind === spec.slice(2);
  }
  function filter(spec) {
    btns.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-filter') === spec ? 'true' : 'false'); });
    rows.forEach(function (el) { el.hidden = !keeps(byOrd[el.getAttribute('data-ordinal')], spec); });
    nodes.forEach(function (el) { flag(el, 'data-og-dim', !keeps(byOrd[el.getAttribute('data-ordinal')], spec)); });
  }
  rows.forEach(function (el) { el.addEventListener('click', function () { show(el.getAttribute('data-ordinal')); }); });
  nodes.forEach(function (el) {
    el.addEventListener('click', function () { show(el.getAttribute('data-ordinal')); });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(el.getAttribute('data-ordinal')); }
    });
  });
  btns.forEach(function (b) { b.addEventListener('click', function () { filter(b.getAttribute('data-filter')); }); });
})();
`;
