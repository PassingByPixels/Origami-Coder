// The static artifact's INLINE behaviour, part one: the camera, the selection
// and the hover card. Two more parts are spliced in below AS TEXT, so all three
// share ONE closure — mapHtmlDetail.ts writes the right-hand panel, and
// mapHtmlRails.ts owns the rails (search, the kind and pillar filters, the flow
// list, the fold/resize handles and the view toggles).
//
// That splice is the only unusual thing here, and it is deliberate: the other two
// need `byId`, the element caches, `selectFlow`, `applyFilters` and `home`, and
// the alternative to sharing a closure is a global handshake on `window` inside a
// file whose whole point is that it is a sealed, offline document. The split is a
// real one — surface, panel, controls — taken because the file was at its cap.
//
// EVERY string that came from the cartographer reaches the DOM through
// `textContent`, never innerHTML. That rule is not decorative: the artifact's
// first version concatenated a node name into innerHTML, so a node called
// `<img onerror=...>` armed a live handler the moment a flow was clicked. The
// runtime JSDOM tests in mapHtml.test.ts click a flow AND a box precisely to keep
// that shut. It is also why this file does not simply carry the mockup's
// innerHTML rendering across — the picture is the mockup's, the DOM writes are
// this repository's.
//
// The script also builds NO SVG. Flow traces and edge labels are server-rendered
// hidden and toggled by class, so this file never needs createElementNS and its
// namespace URI — which would otherwise be the only `http://` string in a
// document whose whole contract is that it fetches nothing.

import { MAP_DETAIL_JS } from './mapHtmlDetail';
import { MAP_RAILS_JS } from './mapHtmlRails';

export const MAP_JS = `
(function () {
  var byId = {}; MAP.nodes.forEach(function (n) { byId[n.id] = n; });
  var deg = {};
  MAP.edges.forEach(function (e) { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
  var keyWhy = {}; (MAP.keyFiles || []).forEach(function (k) { keyWhy[k.path] = k.why; });
  var stage = document.getElementById('stage');
  var cam = document.getElementById('cam');
  var wrap = document.getElementById('stage-wrap');
  var tip = document.getElementById('tip');
  var detail = document.getElementById('detail');
  var nodeEls = {}, captionEls = {}, lkEls = [], elabEls = {}, traceEls = [];
  [].slice.call(document.querySelectorAll('.node')).forEach(function (g) { nodeEls[g.getAttribute('data-node')] = g; });
  [].slice.call(document.querySelectorAll('#names text')).forEach(function (t) { captionEls[t.getAttribute('data-name')] = t; });
  [].slice.call(document.querySelectorAll('.lk')).forEach(function (g) { lkEls.push(g); });
  [].slice.call(document.querySelectorAll('.elab')).forEach(function (t) { elabEls[t.getAttribute('data-elab')] = t; });
  [].slice.call(document.querySelectorAll('.trace')).forEach(function (g) { traceEls.push(g); });
  var sel = '', flow = '';

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function put(parent, tag, text, cls) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    parent.appendChild(el);
    return el;
  }
  function chip(parent, text, colour) {
    var c = put(parent, 'span', text, 'chip');
    c.style.background = colour + '33';
    c.style.color = colour;
    return c;
  }
  function kindColour(kind) { return MAP.kinds[kind] || '#64748b'; }
  function flowColour(i) { return MAP.flowColours[i % MAP.flowColours.length]; }

  // ---- selection paint --------------------------------------------------------
  function paint() {
    var conn = {};
    if (sel) { conn[sel] = 1; MAP.edges.forEach(function (e) { if (e.from === sel || e.to === sel) { conn[e.from] = 1; conn[e.to] = 1; } }); }
    var inFlow = {};
    if (flow) { MAP.flows.forEach(function (f) { if (f.id === flow) f.steps.forEach(function (s) { inFlow[s.node] = 1; }); }); }
    Object.keys(nodeEls).forEach(function (id) {
      var el = nodeEls[id];
      el.classList.toggle('sel', id === sel);
      el.classList.toggle('dim', (sel !== '' && !conn[id]) || (flow !== '' && !inFlow[id]));
    });
    lkEls.forEach(function (g) {
      var hot = sel !== '' && (g.getAttribute('data-from') === sel || g.getAttribute('data-to') === sel);
      g.classList.toggle('hot', hot);
      g.classList.toggle('dim', (sel !== '' && !hot) || flow !== '');
      var lab = elabEls[g.getAttribute('data-lk')];
      if (lab) lab.classList.toggle('on', hot);
    });
    traceEls.forEach(function (g) { g.classList.toggle('on', g.getAttribute('data-flow') === flow); });
    [].slice.call(document.querySelectorAll('.flow-btn')).forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-flow') === flow);
    });
  }

${MAP_DETAIL_JS}

  function clearSel() { sel = ''; flow = ''; idleDetail(); paint(); }
  function selectNode(id) { sel = (sel === id ? '' : id); flow = ''; if (sel) nodeDetail(sel); else idleDetail(); paint(); }
  function selectFlow(id) { flow = (flow === id ? '' : id); sel = ''; if (flow) flowDetail(flow); else idleDetail(); paint(); }

  // ---- hover card -------------------------------------------------------------
  function showTip(id) {
    var n = byId[id];
    if (!n) return;
    clear(tip);
    put(tip, 'div', n.name, 't-name');
    var meta = put(tip, 'div', null, 't-meta');
    chip(meta, n.kind, kindColour(n.kind));
    var d = deg[n.id] || 0;
    put(meta, 'span', ' pillar ' + n.pillar + (n.section ? ' \\u00b7 ' + n.section : '')
      + ' \\u00b7 ' + d + ' edge' + (d === 1 ? '' : 's') + (keyWhy[n.path] ? ' \\u00b7 KEY FILE' : ''));
    put(tip, 'div', n.summary, 't-sum');
    if (n.path) put(tip, 'div', n.path, 't-path');
    tip.classList.add('on');
  }
  function hideTip() { tip.classList.remove('on'); }
  wrap.addEventListener('mousemove', function (ev) {
    var r = wrap.getBoundingClientRect();
    var x = ev.clientX - r.left + 16, y = ev.clientY - r.top + 16;
    if (x + tip.offsetWidth > r.width - 8) x = Math.max(6, ev.clientX - r.left - tip.offsetWidth - 12);
    if (y + tip.offsetHeight > r.height - 8) y = Math.max(6, ev.clientY - r.top - tip.offsetHeight - 12);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });

  // ---- camera -----------------------------------------------------------------
  // The stage keeps its viewBox; only #cam is transformed, so nothing reflows.
  // Client px become USER units through the viewBox fit for
  // preserveAspectRatio="xMidYMid meet". A zero-sized box (a headless DOM, a
  // hidden tab) makes that conversion meaningless, so both handlers no-op there
  // rather than divide by zero and throw the camera to Infinity.
  var tx = 0, ty = 0, k = 1, moved = 0;
  function apply() { cam.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + k + ')'); }
  function unit() {
    var r = stage.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0 && MAP.view.w > 0 && MAP.view.h > 0)) return null;
    var s = Math.min(r.width / MAP.view.w, r.height / MAP.view.h);
    return { s: s, r: r, ox: (r.width - MAP.view.w * s) / 2, oy: (r.height - MAP.view.h * s) / 2 };
  }
  function home() { tx = 0; ty = 0; k = 1; apply(); }
  stage.addEventListener('wheel', function (ev) {
    var u = unit();
    if (!u) return;
    ev.preventDefault();
    var ux = (ev.clientX - u.r.left - u.ox) / u.s + MAP.view.x;
    var uy = (ev.clientY - u.r.top - u.oy) / u.s + MAP.view.y;
    var next = Math.min(4, Math.max(0.25, k * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
    tx = ux - (ux - tx) * (next / k);
    ty = uy - (uy - ty) * (next / k);
    k = next;
    apply();
    autoLabels();
  }, { passive: false });
  var from = null;
  stage.addEventListener('mousedown', function (ev) {
    var u = unit();
    from = { x: ev.clientX, y: ev.clientY, tx: tx, ty: ty, s: u ? u.s : 0 };
    moved = 0;
    stage.classList.add('grabbing');
  });
  window.addEventListener('mouseup', function () { from = null; stage.classList.remove('grabbing'); });
  window.addEventListener('mousemove', function (ev) {
    if (!from) return;
    moved = Math.max(moved, Math.abs(ev.clientX - from.x) + Math.abs(ev.clientY - from.y));
    if (!(from.s > 0)) return;
    tx = from.tx + (ev.clientX - from.x) / from.s;
    ty = from.ty + (ev.clientY - from.y) / from.s;
    apply();
  });

  Object.keys(nodeEls).forEach(function (id) {
    var el = nodeEls[id];
    el.addEventListener('click', function () { if (moved < 5) selectNode(id); });
    el.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectNode(id); }
    });
    el.addEventListener('mouseenter', function () { showTip(id); });
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('focus', function () { showTip(id); });
    el.addEventListener('blur', hideTip);
  });
  stage.addEventListener('click', function (ev) {
    if (moved >= 5) return;
    var hit = ev.target && ev.target.closest ? ev.target.closest('.node') : null;
    if (!hit) clearSel();
  });

${MAP_RAILS_JS}

  idleDetail();
  paint();
  applyFilters();
  autoLabels();
})();
`;
