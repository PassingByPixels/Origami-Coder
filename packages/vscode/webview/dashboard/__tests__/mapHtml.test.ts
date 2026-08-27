// mapHtml (S15) unit tests: the self-contained static map.html renderer. These
// assert the artifact is a complete, self-contained document that ESCAPES map
// strings (a node name with markup must never break the page or inject script)
// and embeds the flow/node data the inline JS reads. The escaping test would
// catch a real bug: a cartographer naming a node "<img onerror=...>".
//
// flow-spine update: the artifact is the picked mockup's drawing — streets, kind
// colours, two filter legends and two folding rails. Four things are pinned here:
//  1. SELF-CONTAINED, strictly. The document must contain no `http`/`https`
//     string at all — not a link, not a font, not even an SVG namespace URI, and
//     not in a comment — and no fetch/XHR/dynamic import. It is opened off a
//     file:// URL with the network gone; that is the state a saved artifact
//     actually lives in.
//  2. The picture is NOT redrawn here. Its coordinates are asserted to BE the
//     numbers layoutMap() returns, so the artifact and the in-editor screen
//     cannot drift apart — the same technique labyrinthAtlas.test.ts uses.
//  3. Every runtime sink stays textContent. Clicking a flow was covered; the
//     detail panel and the hover card are two more, and both are filled from the
//     same untrusted strings.
//  4. The controls exist and DO something: a kind toggle, a pillar toggle and a
//     search must actually remove boxes from the picture.
//
// What jsdom CANNOT check here is anything with a size: it has no layout engine,
// so the rails' drag-resize, the fold's effect on the stage width and the zoom
// are verified in a real browser engine instead (see the flow-spine preview run).

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderMapHtml } from '../../../src/dashboard/agentManager/mapHtml';
import { layoutMap } from '../../../src/dashboard/agentManager/isoLayout';
import { polyPoints } from '../../../src/dashboard/agentManager/isoProject';
import type { RepoMap } from '../../../src/dashboard/agentManager/mapSchema';

function map(overrides: Partial<RepoMap> = {}): RepoMap {
  return {
    version: 2,
    builtAt: { sha: 'abcdef1234567890', branch: 'main', at: 1700000000000 },
    name: 'demo',
    summary: 'a fixture app',
    nodes: [{ id: 'app', name: 'App', pillar: 1, kind: 'entrypoint', path: 'src/app.ts', summary: 'entry' }],
    edges: [],
    flows: [{ id: 'boot', name: 'Boot', description: 'startup sequence', steps: [{ node: 'app', note: 'mount' }] }],
    keyFiles: [{ path: 'src/app.ts', why: 'entry' }],
    conventions: ['no default exports'],
    ...overrides,
  };
}

/** A DOM that actually runs the artifact's inline script. */
function live(html: string): JSDOM {
  return new JSDOM(html, { runScripts: 'dangerously' });
}
const fire = (dom: JSDOM, el: Element, type: string): void => {
  el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: type === 'click' }));
};

describe('renderMapHtml', () => {
  it('produces a complete, self-contained document with no external asset references', () => {
    const html = renderMapHtml(map());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).toContain('demo');            // the map name
    expect(html).toContain('main @ abcdef1');  // short-sha built label
    expect(html).not.toMatch(/<link[^>]+href=["']http/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
  });

  it('contains NO url and NO network call of any kind', () => {
    // The blunt version of the rule above, over the whole document — comments
    // included, which is not pedantry: a CSS comment explaining WHY the file
    // avoids a namespace URI once put the only `http://` string in the artifact
    // into the artifact.
    const html = renderMapHtml(map({
      nodes: [{ id: 'n', name: 'N', pillar: 3, kind: 'gate', summary: 's' }],
      flows: [], edges: [],
    }));
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/XMLHttpRequest|EventSource|WebSocket|navigator\.sendBeacon|createElementNS/);
    expect(html).not.toMatch(/@import|<img\b|<iframe\b|<link\b/i);
  });

  it('ESCAPES markup in map strings so a node name cannot break the page or inject', () => {
    const html = renderMapHtml(map({
      nodes: [{ id: 'x', name: '<img src=x onerror=alert(1)>', pillar: 1, kind: 'module', summary: 'evil' }],
      flows: [],
    }));
    expect(html).not.toContain('<img src=x onerror=alert(1)>'); // never emitted raw
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;'); // escaped instead
  });

  it('embeds the flow + node data the inline script consumes', () => {
    const html = renderMapHtml(map());
    expect(html).toContain('var MAP =');       // the embedded data
    expect(html).toContain('"boot"');          // the flow id is in the payload
  });

  it('a </script> inside a map string cannot break out of the embedded data', () => {
    const html = renderMapHtml(map({
      nodes: [{ id: 'x', name: '</script><b>pwn', pillar: 1, kind: 'module', summary: 'x' }],
      flows: [{ id: 'boot', name: 'Boot', description: 'x', steps: [{ node: 'x', note: 'go' }] }],
    }));
    expect((html.match(/<\/script>/g) ?? []).length).toBe(1);
  });

  it('truncates a long caption on the RAW name, so an entity is never cut in half', () => {
    // esc-then-truncate slices `&amp;` into `&a`, which the parser renders as
    // literal text. The fixture places the `&` AT the cut, so the wrong order
    // splits it and the right order never sees it. The assertion is the real
    // requirement: whatever the caption shows must be a PREFIX of the name.
    const name = `${'x'.repeat(19)}&yes`;
    const html = renderMapHtml(map({
      nodes: [{ id: 'x', name, pillar: 2, kind: 'module', summary: 's' }],
      flows: [], edges: [],
    }));
    const caption = new JSDOM(html).window.document.querySelector('#names text')!.textContent!;
    expect(caption.endsWith('…'), `caption was ${caption}`).toBe(true);
    expect(name.startsWith(caption.slice(0, -1)), `"${caption}" is not a prefix of "${name}"`).toBe(true);
  });

  it('draws the picture at EXACTLY the coordinates layoutMap computes', () => {
    // The artifact must not own a second copy of the geometry. Pinning the
    // polygons AND the curve to the pure modules is what makes "one layout, two
    // renderers" a checked claim instead of an intention.
    const m = map({
      nodes: [
        { id: 'app', name: 'App', pillar: 1, kind: 'entrypoint', summary: 'e' },
        { id: 'out', name: 'Bundle', pillar: 5, kind: 'build', summary: 'o' },
      ],
      edges: [{ from: 'app', to: 'out', label: 'writes' }],
      flows: [],
    });
    const html = renderMapHtml(m);
    const layout = layoutMap(m);
    for (const b of layout.boxes) {
      for (const f of b.plates) {
        expect(html, `top face of ${b.id}`).toContain(polyPoints(f.top));
        expect(html, `left face of ${b.id}`).toContain(polyPoints(f.left));
      }
    }
    for (const z of layout.zones) expect(html).toContain(polyPoints(z.poly));
    const l = layout.links[0];
    expect(html).toContain(`d="M ${l.s.x} ${l.s.y} Q ${l.c.x} ${l.c.y} ${l.e.x} ${l.e.y}"`);
    expect(html).toContain(polyPoints(l.head));
    expect(html).toContain(`viewBox="${layout.view.x} ${layout.view.y} ${layout.view.w} ${layout.view.h}"`);
  });

  it('offers a filter for every kind the map ACTUALLY uses, counted', () => {
    // `kind` is a free string in the schema. A legend built from the palette's own
    // list would silently omit "gate" and leave those two components unfilterable.
    const m = map({
      nodes: [
        { id: 'a', name: 'Alpha', pillar: 1, kind: 'entrypoint', summary: 's' },
        { id: 'b', name: 'Beta', pillar: 3, kind: 'gate', summary: 's' },
        { id: 'c', name: 'Gamma', pillar: 3, kind: 'gate', summary: 's' },
      ],
      edges: [], flows: [],
    });
    const doc = new JSDOM(renderMapHtml(m)).window.document;
    const items = [...doc.querySelectorAll('.legend-item')];
    expect(items.map((e) => e.getAttribute('data-kind'))).toEqual(['entrypoint', 'gate']);
    expect(items[1].querySelector('.n')!.textContent).toBe('2');
    expect([...doc.querySelectorAll('.pillar-list li')]).toHaveLength(5); // all five, always
    expect([...doc.querySelectorAll('.node[data-node]')]).toHaveLength(3);
  });

  it('names every street after its flow, and captions the docked districts', () => {
    const m = map({
      nodes: [
        { id: 'a', name: 'Alpha', pillar: 1, kind: 'cli', summary: 's' },
        { id: 'z', name: 'Zeta', pillar: 4, kind: 'dep', summary: 's', section: 'Infra' },
      ],
      edges: [],
      flows: [{ id: 'run', name: 'Runs the thing', description: 'd', steps: [{ node: 'a', note: 'go' }] }],
    });
    const text = new JSDOM(renderMapHtml(m)).window.document.getElementById('zlab')!.textContent!;
    expect(text).toContain('FLOW 1 · Runs the thing');
    expect(text).toContain('1 steps · 1 components live here');
    expect(text).toContain('4 · External Dependencies & Infrastructure');
    expect(text).toContain('Infra (1)');
  });

  it('RUNTIME: selecting a flow renders a markup node name as inert text, injecting no live element', () => {
    // Load the real artifact into a script-running DOM and click the flow: the
    // steps panel must build the node name via textContent, so a name like
    // `<img onerror=...>` is shown as text and its handler never arms. Break the
    // fix (concat name into innerHTML) and the query below finds a live element.
    const evil = '<img src=x onerror="window.__PWNED__=true">';
    const html = renderMapHtml(map({
      nodes: [{ id: 'x', name: evil, pillar: 1, kind: 'module', summary: 's' }],
      flows: [{ id: 'boot', name: 'Boot', description: 'x', steps: [{ node: 'x', note: 'go' }] }],
    }));
    const dom = live(html);
    const doc = dom.window.document;
    fire(dom, doc.querySelector('.flow-btn')!, 'click');
    const detail = doc.getElementById('detail')!;
    expect(detail.querySelector('img')).toBeNull();
    expect(dom.window.__PWNED__).toBeUndefined();
    expect(detail.textContent).toContain(evil);                       // inert text
    expect(doc.querySelectorAll('.trace.on')).toHaveLength(1);        // and the trace lit up
    dom.window.close();
  });

  it('RUNTIME: selecting a BOX fills the detail panel as inert text too', () => {
    const evil = '<img src=x onerror="window.__PWNED__=true">';
    const html = renderMapHtml(map({
      nodes: [
        { id: 'x', name: evil, pillar: 2, kind: 'module', summary: `sum ${evil}`, path: `p/${evil}`, status: 'modified' },
        { id: 'y', name: 'Plain', pillar: 3, kind: 'gate', summary: 's' },
      ],
      edges: [{ from: 'x', to: 'y', label: evil }],
      flows: [],
    }));
    const dom = live(html);
    const doc = dom.window.document;
    fire(dom, doc.querySelector('.node[data-node="x"]')!, 'click');
    const detail = doc.getElementById('detail')!;
    expect(detail.querySelector('img')).toBeNull();
    expect(dom.window.__PWNED__).toBeUndefined();
    expect(detail.querySelector('h3')!.textContent).toBe(evil);
    expect(detail.textContent).toContain(`sum ${evil}`);   // summary
    expect(detail.textContent).toContain(`p/${evil}`);     // path
    expect(detail.textContent).toContain('Connections (1)');
    // ...and the `status` is SPELLED OUT, not left as a one-word badge. The badge
    // tells the reader the field exists; it never tells them what it claims.
    expect(detail.textContent).toContain('modified - it changed since the previous map was built.');
    dom.window.close();
  });

  it('RUNTIME: the idle panel lists what changed since the previous map', () => {
    const dom = live(renderMapHtml(map({
      nodes: [
        { id: 'a', name: 'Alpha', pillar: 1, kind: 'cli', summary: 's', status: 'new' },
        { id: 'b', name: 'Beta', pillar: 2, kind: 'core', summary: 's', status: 'unchanged' },
      ],
      edges: [], flows: [],
    })));
    const idle = dom.window.document.getElementById('detail')!.textContent!;
    expect(idle).toContain('Changed since the previous map');
    expect(idle).toContain('new · Alpha');
    expect(idle).not.toContain('Beta');   // unchanged is not a change
    dom.window.close();
  });

  it('RUNTIME: the hover card reads out the component, also as inert text', () => {
    const evil = '<img src=x onerror="window.__PWNED__=true">';
    const dom = live(renderMapHtml(map({
      nodes: [{ id: 'x', name: evil, pillar: 1, kind: 'cli', summary: `about ${evil}`, path: 'src/app.ts' }],
      edges: [], flows: [], keyFiles: [{ path: 'src/app.ts', why: 'the entry' }],
    })));
    const doc = dom.window.document;
    const tip = doc.getElementById('tip')!;
    expect(tip.classList.contains('on')).toBe(false);
    fire(dom, doc.querySelector('.node[data-node="x"]')!, 'mouseenter');
    expect(tip.classList.contains('on')).toBe(true);
    expect(tip.querySelector('img')).toBeNull();
    expect(dom.window.__PWNED__).toBeUndefined();
    expect(tip.textContent).toContain(evil);
    expect(tip.textContent).toContain('KEY FILE');
    fire(dom, doc.querySelector('.node[data-node="x"]')!, 'mouseleave');
    expect(tip.classList.contains('on')).toBe(false);
    dom.window.close();
  });

  it('RUNTIME: the search and the two legends actually remove boxes from the picture', () => {
    const dom = live(renderMapHtml(map({
      nodes: [
        { id: 'a', name: 'Alpha', pillar: 1, kind: 'entrypoint', summary: 'the first' },
        { id: 'b', name: 'Beta', pillar: 3, kind: 'gate', summary: 'the second' },
      ],
      edges: [], flows: [],
    })));
    const doc = dom.window.document;
    const hidden = (): string[] => [...doc.querySelectorAll('.node.hide')].map((e) => e.getAttribute('data-node')!);
    const search = doc.getElementById('search') as HTMLInputElement;
    search.value = 'second';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(hidden()).toEqual(['a']);
    // ...and the caption goes with the box, or the map keeps a floating name.
    expect(doc.querySelector('#names text[data-name="a"]')!.classList.contains('hide')).toBe(true);
    search.value = '';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(hidden()).toEqual([]);
    fire(dom, doc.querySelector('.legend-item[data-kind="gate"]')!, 'click');
    expect(hidden()).toEqual(['b']);
    fire(dom, doc.querySelector('.legend-item[data-kind="gate"]')!, 'click');
    fire(dom, doc.querySelector('.pillar-list li[data-pillar="1"]')!, 'click');
    expect(hidden()).toEqual(['a']);
    dom.window.close();
  });

  it('RUNTIME: the rails fold away and the view toggles flip', () => {
    // jsdom has no layout, so this asserts the STATE the CSS keys off — that the
    // rail is marked hidden and the toggles carry their class. Whether the stage
    // actually grows is a real-browser check.
    const dom = live(renderMapHtml(map()));
    const doc = dom.window.document;
    fire(dom, doc.getElementById('btn-left')!, 'click');
    expect(doc.getElementById('rail-l')!.hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('grip-l')!.hasAttribute('hidden')).toBe(true);
    fire(dom, doc.getElementById('btn-left')!, 'click');
    expect(doc.getElementById('rail-l')!.hasAttribute('hidden')).toBe(false);
    fire(dom, doc.getElementById('btn-right')!, 'click');
    expect(doc.getElementById('rail-r')!.hasAttribute('hidden')).toBe(true);
    const labels = doc.getElementById('btn-labels')!;
    fire(dom, labels, 'click');
    expect(labels.textContent).toBe('Names: all');
    fire(dom, labels, 'click');
    expect(doc.getElementById('stage')!.classList.contains('nonames')).toBe(true);
    fire(dom, doc.getElementById('btn-edges')!, 'click');
    expect(doc.getElementById('stage')!.classList.contains('noedges')).toBe(true);
    dom.window.close();
  });

  it('RUNTIME: a map with no nodes, edges or flows still renders a working page', () => {
    // validateMap accepts all three empty, so this reaches the renderer. It used
    // to be the shape that produced a NaN viewBox and a blank stage.
    const dom = live(renderMapHtml(map({ nodes: [], edges: [], flows: [], keyFiles: [], conventions: [] })));
    const doc = dom.window.document;
    expect(doc.querySelectorAll('.node')).toHaveLength(0);
    expect(doc.getElementById('stage')!.getAttribute('viewBox')).not.toContain('NaN');
    expect(doc.getElementById('detail')!.textContent).toContain('About this map');
    dom.window.close();
  });
});
