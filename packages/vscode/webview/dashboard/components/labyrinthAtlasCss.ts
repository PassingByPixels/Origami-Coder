// The exported ATLAS's layout — a full-bleed console rather than a document.
//
// The shape is the owner-picked candidate: a pinned header carrying the run's
// identity and the Flock usage strip, a filter row under it, then ONE scrolling
// map pane with a permanent inspector rail beside it, and the step ledger
// demoted to a drawer along the bottom. Nothing but the panes scroll, so the
// header and the rail never leave the screen while a 500-step run is browsed.
//
// Two rules this file is deliberately written around, both learned the hard way
// and both asserted in labyrinthPane.test.ts against the artifact:
//
//  - NO `min-width`. The on-screen pane's min-width used to ride along in the
//    serialized svg and pin the picture off-centre; the artifact is checked for
//    the string outright. `.mapwrap` needs none anyway — a flex item whose
//    overflow is not `visible` already has an automatic minimum size of zero.
//  - NO `display:none`. A <title> in the map computes to it, and stamping that
//    onto the clone would kill every tooltip in the file. The drawer therefore
//    hides on the plain `hidden` ATTRIBUTE, which the UA sheet already handles —
//    so `.drawer` must not declare a `display` of its own or it would win.
//
// The map is centred with `margin:auto` on the map wrapper's child, NOT with
// justify-content: centring an OVERFLOWING flex item puts its leading edge out
// of scroll reach, and a 60-step thread overflows. This is the same rule the
// live pane's .lab-canvas uses, for the same reason.
//
// Colours are `var(--og-*)` only — labyrinthExport.ts's resolver turns them into
// the concrete palette of the theme the map was actually drawn under.

export const ATLAS_CSS = `
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--og-bg); color: var(--og-text); overflow: hidden;
  font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px; line-height: 1.5; }
.app { display: flex; flex-direction: column; height: 100%; }

header { flex: none; border-bottom: 1px solid var(--og-border); background: var(--og-surface);
  padding: 11px 18px 0; }
.hrow { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.brand { font-size: 9px; letter-spacing: 0.19em; text-transform: uppercase; color: var(--og-text-muted); }
h1 { font-size: 15px; font-weight: 600; margin: 0; }
.meta { font-size: 11px; color: var(--og-text-muted); margin-left: auto; }
.meta span + span::before { content: " \\00b7 "; }
.warn { margin: 9px 0 0; padding: 7px 10px; border: 1px solid var(--og-border);
  border-left: 3px solid var(--og-warning); background: var(--og-warning-soft); border-radius: 4px;
  font-size: 11px; color: var(--og-warning-text); }

.strip { display: flex; align-items: stretch; border-top: 1px solid var(--og-border);
  margin: 9px -18px 0; padding: 0 18px; overflow-x: auto; }
.cell { padding: 9px 18px 10px; border-right: 1px solid var(--og-border); flex: none; }
.cell:first-child { padding-left: 0; }
.cell .l { font-size: 8px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--og-text-muted); display: block; margin-bottom: 3px; }
.cell .v { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.cell .v small { font-size: 10px; font-weight: 400; color: var(--og-text-muted); margin-left: 3px; }
.cell.total .v { color: var(--og-warning); }
.cell.bars { flex: 1 1 210px; border-right: none; display: flex; flex-direction: column; justify-content: center; }
.bar { display: flex; height: 7px; border-radius: 4px; overflow: hidden; background: var(--og-surface-alt); }
.bar i { display: block; height: 100%; }
.barleg { display: flex; gap: 12px; font-size: 10px; color: var(--og-text-muted); margin-top: 5px; flex-wrap: wrap; }
.sw { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 5px; }
.floor { font-size: 10px; line-height: 1.45; color: var(--og-warning); padding: 7px 0 8px; }

.tools { flex: none; display: flex; align-items: center; gap: 6px; padding: 8px 18px;
  border-bottom: 1px solid var(--og-border); background: var(--og-surface); flex-wrap: wrap; }
.filters { display: flex; flex-wrap: wrap; gap: 6px; }
.tools button { font: inherit; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 4px 11px; border-radius: 11px; cursor: pointer; background: var(--og-btn-bg);
  color: var(--og-text-secondary); border: 1px solid var(--og-border); }
.tools button:hover { color: var(--og-text); background: var(--og-btn-hover); }
.tools button[aria-pressed="true"] { background: var(--og-surface-alt); color: var(--og-text);
  border-color: var(--og-accent-2); }
.tools .sw { border-radius: 50%; }
.tools .spacer { flex: 1; }
.tools .n { color: var(--og-text-muted); margin-left: 5px; }

main { flex: 1; display: flex; min-height: 0; }
/* The map pane scrolls; the picture centres inside it on BOTH axes. */
.mapwrap { flex: 1; overflow: auto; display: flex; padding: 18px; }
#og-map { margin: auto; }
#og-map svg { display: block; }
.railwrap { flex: none; width: 400px; border-left: 1px solid var(--og-border);
  background: var(--og-surface); display: flex; flex-direction: column; min-height: 0; }
.rail-bar { flex: none; display: flex; align-items: center; gap: 8px; padding: 9px 15px;
  border-bottom: 1px solid var(--og-border); font-size: 9px; letter-spacing: 0.15em;
  text-transform: uppercase; color: var(--og-text-muted); }
.rail-bar .dotmark { width: 6px; height: 6px; border-radius: 50%; background: var(--og-accent-2); }
.detail { flex: 1; overflow: auto; padding: 14px 15px 26px; }

/* .drawer declares NO display, so the plain hidden attribute alone closes it. */
.drawer { flex: none; border-top: 1px solid var(--og-border); background: var(--og-surface); }
.dw-bar { display: flex; align-items: center; gap: 10px; padding: 8px 18px;
  border-bottom: 1px solid var(--og-border); font-size: 9px; letter-spacing: 0.15em;
  text-transform: uppercase; color: var(--og-text-muted); }
.dw-bar button { margin-left: auto; font: inherit; font-size: 9px; letter-spacing: 0.12em;
  text-transform: uppercase; background: var(--og-btn-bg); border: 1px solid var(--og-border);
  color: var(--og-text-secondary); border-radius: 9px; padding: 3px 10px; cursor: pointer; }
.dwbody { max-height: 38vh; overflow: auto; }
/* max-content, NOT 100%: a run carries model ids 130 characters long, and a
   table forced to the drawer's width pays for that nowrap column by crushing
   the TITLE column to one character per line. Sized to its content instead, the
   ledger keeps every column legible and the drawer scrolls. */
table { border-collapse: collapse; width: max-content; font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
th, td { padding: 4px 10px; text-align: left; vertical-align: top; white-space: nowrap;
  border-bottom: 1px solid var(--og-border); }
th { font-size: 8px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--og-text-secondary);
  position: sticky; top: 0; background: var(--og-surface-alt); font-family: inherit; z-index: 2; }
td { color: var(--og-text-secondary); }
td.t { white-space: normal; max-width: 34em; word-break: break-word; color: var(--og-text); }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--og-surface-alt); }
`;
