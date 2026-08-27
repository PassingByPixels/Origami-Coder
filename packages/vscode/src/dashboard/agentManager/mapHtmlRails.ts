// The static artifact's INLINE behaviour, part two: the two rails. Search, the
// kind and pillar filters, the flow list, the view toggles, and the grips that
// resize a rail or fold it away entirely.
//
// THIS STRING IS SPLICED INSIDE mapHtmlScript.ts's IIFE, on purpose, and it reads
// that closure directly: `byId`, `nodeEls`, `captionEls`, `stage`, `k`,
// `selectFlow`, `clearSel` and `home`. It also DEFINES the two functions the core
// calls back into — `applyFilters` and `autoLabels` — which reach the core
// through function-declaration hoisting, so the order of the two halves in the
// emitted file does not matter.
//
// It is a text splice rather than a second IIFE because the alternative is a
// global handshake on `window` inside a sealed offline document, and a split for
// a LINE CAP should not change the artifact's shape. The split itself is real:
// the core owns the drawing surface, this owns the controls around it.
//
// Every control is server-rendered by mapHtml.ts (escaped there); nothing here
// builds markup, and nothing here writes a cartographer string into innerHTML.

export const MAP_RAILS_JS = `
  // ---- find / kind / pillar --------------------------------------------------
  var search = document.getElementById('search');
  var hidKind = {}, hidPillar = {};
  function applyFilters() {
    var q = ((search && search.value) || '').toLowerCase();
    Object.keys(nodeEls).forEach(function (id) {
      var n = byId[id];
      var hay = (n.name + ' ' + n.kind + ' ' + (n.path || '') + ' ' + n.summary + ' ' + (n.section || '')).toLowerCase();
      var on = (!q || hay.indexOf(q) >= 0) && !hidKind[n.kind] && !hidPillar[String(n.pillar)];
      nodeEls[id].classList.toggle('hide', !on);
      if (captionEls[id]) captionEls[id].classList.toggle('hide', !on);
    });
  }
  if (search) search.addEventListener('input', applyFilters);
  [].slice.call(document.querySelectorAll('.legend-item')).forEach(function (el) {
    el.addEventListener('click', function () {
      var kind = el.getAttribute('data-kind');
      hidKind[kind] = !hidKind[kind];
      el.classList.toggle('off', !!hidKind[kind]);
      applyFilters();
    });
  });
  [].slice.call(document.querySelectorAll('.pillar-list li')).forEach(function (el) {
    el.addEventListener('click', function () {
      var p = el.getAttribute('data-pillar');
      hidPillar[p] = !hidPillar[p];
      el.classList.toggle('off', !!hidPillar[p]);
      applyFilters();
    });
  });
  [].slice.call(document.querySelectorAll('.flow-btn')).forEach(function (b) {
    b.addEventListener('click', function () { selectFlow(b.getAttribute('data-flow')); });
  });

  // ---- names / edges / fit ---------------------------------------------------
  // AUTO means "label what the map says matters": anything with an edge or a flow
  // step. On a 63-node map that is the difference between a readable picture and
  // a wall of 8px text. Zooming in shows the rest.
  var LABELS = ['auto', 'all', 'off'], mode = 0;
  function autoLabels() {
    stage.classList.toggle('nonames', LABELS[mode] === 'off');
    if (LABELS[mode] === 'off') return;
    Object.keys(captionEls).forEach(function (id) {
      var t = captionEls[id];
      var busy = Number(t.getAttribute('data-deg')) > 0;
      t.style.opacity = (LABELS[mode] === 'all' || k > 1.3 || busy) ? '1' : '0';
    });
  }
  function onClick(id, fn) { var b = document.getElementById(id); if (b) b.addEventListener('click', fn); return b; }
  var btnLabels = onClick('btn-labels', function () {
    mode = (mode + 1) % LABELS.length;
    btnLabels.textContent = 'Names: ' + LABELS[mode];
    autoLabels();
  });
  var btnEdges = onClick('btn-edges', function () {
    btnEdges.classList.toggle('on', !stage.classList.toggle('noedges'));
  });
  onClick('btn-fit', function () { home(); autoLabels(); });
  onClick('btn-reset', function () { clearSel(); home(); autoLabels(); });

  // ---- rails: fold away, or drag to resize -----------------------------------
  var MIN_RAIL = 150;
  function ceilingOf(rect) { return rect.width > 0 ? Math.max(MIN_RAIL, rect.width * 0.6) : Infinity; }
  function fold(btnId, railId, gripId) {
    var btn = document.getElementById(btnId), rail = document.getElementById(railId), grip = document.getElementById(gripId);
    if (!btn || !rail || !grip) return;
    btn.addEventListener('click', function () {
      var folded = rail.hasAttribute('hidden');
      if (folded) { rail.removeAttribute('hidden'); grip.removeAttribute('hidden'); }
      else { rail.setAttribute('hidden', ''); grip.setAttribute('hidden', ''); }
      btn.classList.toggle('on', folded);
    });
  }
  function resize(gripId, railId, edge) {
    var grip = document.getElementById(gripId), rail = document.getElementById(railId);
    var app = document.getElementById('app');
    if (!grip || !rail || !app) return;
    var dragging = false;
    function widthAt(clientX) {
      var r = app.getBoundingClientRect();
      var raw = edge === 'left' ? clientX - r.left : r.right - clientX;
      return Math.min(ceilingOf(r), Math.max(MIN_RAIL, Math.round(raw)));
    }
    grip.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      dragging = true;
      if (grip.setPointerCapture) grip.setPointerCapture(ev.pointerId);
    });
    window.addEventListener('pointermove', function (ev) { if (dragging) rail.style.width = widthAt(ev.clientX) + 'px'; });
    window.addEventListener('pointerup', function () { dragging = false; });
    // Keyboard nudge, so the rails are adjustable without a pointer. ArrowRight
    // always means "move the divider right", which grows the LEFT rail and
    // shrinks the right one — the two grips feel the same to use.
    grip.addEventListener('keydown', function (ev) {
      var dir = ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowRight' ? 1 : 0;
      if (!dir) return;
      ev.preventDefault();
      var now = rail.getBoundingClientRect().width || parseFloat(rail.getAttribute('data-w')) || MIN_RAIL;
      var r = app.getBoundingClientRect();
      rail.style.width = Math.min(ceilingOf(r), Math.max(MIN_RAIL, Math.round(now + dir * (edge === 'left' ? 20 : -20)))) + 'px';
    });
  }
  fold('btn-left', 'rail-l', 'grip-l');
  fold('btn-right', 'rail-r', 'grip-r');
  resize('grip-l', 'rail-l', 'left');
  resize('grip-r', 'rail-r', 'right');
`;
