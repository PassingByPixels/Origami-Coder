// The static artifact's DETAIL PANEL: the right rail's contents in each of its
// three states — a selected component with its connections, a traced flow with
// its steps, and the idle state, which is the map's own index (summary, key
// files, conventions).
//
// THIS STRING IS SPLICED INSIDE mapHtmlScript.ts's IIFE and reads that closure
// directly: `detail`, `byId`, `keyWhy`, `MAP`, and the `put` / `clear` / `chip` /
// `kindColour` / `flowColour` helpers. It defines the three writers the core and
// the rails call, which reach them through function-declaration hoisting.
//
// EVERY string that came from the cartographer reaches the DOM through
// textContent, never innerHTML. That rule is why this file exists in this shape
// at all: the mockup this artifact is ported from builds the same three panels
// with escaped innerHTML, and one missed escape there is a live handler armed by
// a node name. The runtime JSDOM tests in mapHtml.test.ts click a flow AND a box
// AND hover a solid precisely to keep that shut.

export const MAP_DETAIL_JS = `
  // ---- the right rail ---------------------------------------------------------
  // A node's \`status\` is spelled out, never left as a one-word badge: the badge
  // told the reader the field existed, it never told them what it was claiming.
  var COND = {
    'new': 'new - absent from the previous map.',
    modified: 'modified - it changed since the previous map was built.',
    removed: 'removed - the previous map had it; the code no longer does.',
    unchanged: 'unchanged since the previous map.'
  };

  function idleDetail() {
    clear(detail);
    var d = put(detail, 'div', null, 'detail');
    put(d, 'div', 'About this map', 'stitle');
    put(d, 'p', MAP.summary || 'No summary recorded.', 'prose');
    var marked = MAP.nodes.filter(function (n) { return n.status && n.status !== 'unchanged'; });
    if (marked.length) {
      put(d, 'div', 'Changed since the previous map', 'stitle');
      var ul = put(d, 'ul');
      marked.forEach(function (n) { var li = put(ul, 'li', n.status + ' \\u00b7 '); put(li, 'b', n.name); });
    }
    if ((MAP.keyFiles || []).length) {
      put(d, 'div', 'Key files (' + MAP.keyFiles.length + ')', 'stitle');
      var kf = put(d, 'ul', null, 'kf');
      MAP.keyFiles.forEach(function (k) { var li = put(kf, 'li'); put(li, 'b', k.path); put(li, 'div', k.why); });
    }
    if ((MAP.conventions || []).length) {
      put(d, 'div', 'Conventions', 'stitle');
      var cv = put(d, 'ul', null, 'conv');
      MAP.conventions.forEach(function (c) { put(cv, 'li', c); });
    }
  }

  function nodeDetail(id) {
    var n = byId[id];
    if (!n) { idleDetail(); return; }
    clear(detail);
    var d = put(detail, 'div', null, 'detail');
    put(d, 'h3', n.name);
    chip(d, n.kind, kindColour(n.kind));
    if (n.status) chip(d, n.status, '#eab308');
    if (keyWhy[n.path]) chip(d, 'key file', '#38bdf8');
    var meta = put(d, 'div', 'Pillar ' + n.pillar + ' \\u00b7 ' + (MAP.pillars[n.pillar] || ''), 'meta');
    if (n.section) put(meta, 'div', 'Section: ' + n.section);
    put(d, 'p', n.summary || 'No summary recorded.');
    if (n.status) put(d, 'p', COND[n.status] || n.status, 'cond');
    if (n.path) put(d, 'div', n.path, 'path');
    if (keyWhy[n.path]) put(d, 'p', 'Key file \\u2014 ' + keyWhy[n.path]);
    var wired = MAP.edges.filter(function (e) { return e.from === id || e.to === id; });
    put(d, 'div', 'Connections (' + wired.length + ')', 'stitle');
    var ul = put(d, 'ul');
    if (!wired.length) put(ul, 'li', 'No edges recorded for this component.');
    wired.forEach(function (e) {
      var out = e.from === id;
      var other = byId[out ? e.to : e.from];
      var li = put(ul, 'li', (out ? '\\u2192 ' : '\\u2190 '));
      put(li, 'b', other ? other.name : (out ? e.to : e.from));
      put(li, 'div', e.label);
    });
    var mine = MAP.flows.filter(function (f) { return f.steps.some(function (s) { return s.node === id; }); });
    if (mine.length) {
      put(d, 'div', 'Appears in flows', 'stitle');
      var fl = put(d, 'ul');
      mine.forEach(function (f) { put(put(fl, 'li'), 'b', f.name); });
    }
  }

  function flowDetail(id) {
    var f = null, i = 0;
    MAP.flows.forEach(function (x, ix) { if (x.id === id) { f = x; i = ix; } });
    if (!f) { idleDetail(); return; }
    clear(detail);
    var d = put(detail, 'div', null, 'detail');
    put(d, 'h3', f.name).style.color = flowColour(i);
    put(d, 'div', f.id + ' \\u00b7 ' + f.steps.length + ' steps', 'meta');
    put(d, 'p', f.description);
    put(d, 'div', 'Path', 'stitle');
    var box = put(d, 'div', null, 'stepbox');
    f.steps.forEach(function (s, k) {
      var row = put(box, 'div', null, 'steprow');
      put(row, 'div', String(k + 1), 'stepn').style.background = flowColour(i);
      var txt = put(row, 'div');
      var n = byId[s.node];
      put(txt, 'div', n ? n.name : s.node, 'sn');
      put(txt, 'div', s.note, 'sd');
    });
  }
`;
