// The static map.html PAGE sheet: the header strip, the two rails, their grips,
// and the controls inside them. The picture's own sheet is mapHtmlDrawCss.ts —
// same split as mapHtmlSvg.ts beside this file, for the same reason (the page and
// the drawing change for completely different causes).
//
// ONE DELIBERATE PALETTE, and it is NOT the editor theme. map.html is opened in
// a browser, off a file:// URL, where no --og-* variable exists and nothing can
// resolve one; the Labyrinth exporter solves that by reading the running document
// at export time, but a map is written by a background run with no document to
// read. So the artifact commits to the cartographer mockup's own palette — the
// dark slate ground the flow-spine plan was designed and picked on — and the
// drawing reads the same on every machine that opens it. The IN-EDITOR screen is
// the surface that follows the user's theme; this one does not, which is why this
// file is not in the theme-discipline guard's list.
//
// Type is system stack only. A webfont would be a network fetch, and
// self-contained is the artifact's whole contract.

export const MAP_CSS = `
  :root {
    --bg: #0b1220; --panel: #111827; --border: #334155; --text: #e2e8f0;
    --muted: #94a3b8; --accent: #38bdf8; --sunk: #0f172a;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--sans); background: var(--bg); color: var(--text);
    height: 100vh; display: flex; flex-direction: column; overflow: hidden; font-size: 12px; }
  header { background: var(--sunk); border-bottom: 1px solid var(--border); padding: 8px 16px;
    display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-shrink: 0; }
  header h1 { font-size: 13px; font-weight: 600; letter-spacing: 0.03em; }
  .sub { font-size: 10px; color: var(--muted); font-family: var(--mono); margin-left: 10px; letter-spacing: 0.02em; }
  .tools { display: flex; align-items: center; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
  .btn { background: var(--sunk); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px;
    color: var(--text); font: inherit; font-size: 10px; font-weight: 600; letter-spacing: 0.05em;
    text-transform: uppercase; cursor: pointer; white-space: nowrap; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.on { border-color: var(--accent); color: var(--accent); background: rgba(56, 189, 248, 0.1); }
  .app { display: flex; flex: 1; min-height: 0; }
  aside { background: var(--panel); padding: 12px; overflow-y: auto; display: flex; flex-direction: column;
    gap: 14px; flex-shrink: 0; width: 214px; }
  .rail-r { width: 296px; }
  aside[hidden] { display: none; }
  /* The drag handle between a rail and the stage. 7px of grab area, a 1px rule
     drawn inside it — the same shape the editor's own dividers take. */
  .grip { flex-shrink: 0; width: 7px; cursor: col-resize; position: relative; background: none; border: 0; padding: 0; }
  .grip::before { content: ''; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px; background: var(--border); }
  .grip:hover::before, .grip:focus-visible::before { background: var(--accent); }
  .grip:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .grip[hidden] { display: none; }
  .stitle { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 7px; }
  .search { width: 100%; background: var(--sunk); border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 9px; color: var(--text); font: inherit; font-size: 12px; }
  .search:focus { outline: none; border-color: var(--accent); }
  .legend-item { display: flex; align-items: center; gap: 8px; font-size: 11px; margin-bottom: 4px;
    cursor: pointer; user-select: none; width: 100%; background: none; border: 0; color: inherit;
    font: inherit; text-align: left; padding: 0; }
  .legend-item.off { opacity: 0.35; }
  .cube { width: 11px; height: 11px; flex-shrink: 0; border-radius: 2px; }
  .n { color: #64748b; font-size: 10px; margin-left: auto; }
  .edge-legend { margin-top: 9px; font-size: 10px; color: var(--muted); }
  .edge-legend div { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .edge-legend i { width: 22px; height: 2px; flex-shrink: 0; }
  .pillar-list { list-style: none; }
  .pillar-list li { font-size: 11px; padding: 5px 7px; margin-bottom: 3px; background: var(--sunk);
    border-radius: 4px; color: var(--muted); border-left: 3px solid var(--border); cursor: pointer; line-height: 1.3; }
  .pillar-list li:hover { color: var(--text); }
  .pillar-list li.off { opacity: 0.35; }
  .flow-btn { display: block; width: 100%; text-align: left; background: var(--sunk); border: 1px solid var(--border);
    border-left-width: 3px; border-radius: 6px; padding: 7px 9px; color: var(--text); font: inherit; font-size: 12px;
    cursor: pointer; margin-bottom: 5px; line-height: 1.3; }
  .flow-btn:hover, .flow-btn.on { border-color: var(--accent); background: rgba(56, 189, 248, 0.1); }
  .flow-btn .fid { display: block; font-size: 10px; color: var(--muted); margin-bottom: 2px; font-family: var(--mono); }
  .prose { font-size: 11px; color: var(--muted); line-height: 1.45; }
  .detail .stitle { margin-top: 14px; }
  .detail h3 { font-size: 13px; margin-bottom: 5px; line-height: 1.3; }
  .detail .meta { font-size: 10px; color: var(--muted); margin: 6px 0; }
  .detail p { font-size: 11.5px; color: #cbd5e1; line-height: 1.5; }
  .detail .cond { font-size: 11px; color: #eab308; margin-top: 8px; }
  .detail .path { font-family: var(--mono); font-size: 10px; color: #64748b; margin-top: 8px;
    word-break: break-all; background: var(--bg); padding: 6px 7px; border-radius: 4px; border: 1px solid var(--border); }
  .detail ul { list-style: none; margin-top: 8px; }
  .detail li { font-size: 11px; color: var(--muted); padding: 4px 0; line-height: 1.4;
    border-bottom: 1px solid rgba(51, 65, 85, 0.35); }
  .detail li b { color: var(--text); font-weight: 600; }
  .chip { display: inline-block; font-size: 9px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 2px 6px; border-radius: 4px; }
  .stepbox { margin-top: 9px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
  .steprow { display: flex; gap: 7px; font-size: 11px; margin-bottom: 6px; align-items: flex-start; }
  .stepn { width: 17px; height: 17px; border-radius: 50%; color: #0b1220; font-size: 9px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
  .steprow .sn { color: var(--text); font-weight: 600; }
  .steprow .sd { color: var(--muted); font-size: 10px; line-height: 1.4; }
  .conv li::before { content: '>'; color: var(--accent); margin-right: 6px; }
  .kf li { font-family: var(--mono); font-size: 10px; word-break: break-all; }
`;
