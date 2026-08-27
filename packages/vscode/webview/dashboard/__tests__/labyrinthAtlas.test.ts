// The exported ATLAS — the owner-picked shape of the run report: a pinned
// header carrying the Flock usage strip, kind filters, the thread centred in one
// scrolling pane with a permanent inspector rail, and the ledger in a drawer.
//
// THE TEST THAT MATTERS IS THE FIRST ONE. The whole point of the export is that
// its thread is not a second drawing of the same run: the artifact carries the
// very SVG the Thread view rendered, so branches departing and merging back, the
// clock axis, collision avoidance and threshold marks arrive from the pure
// geometry modules by construction. "It looks the same" is not evidence, so the
// test recomputes threadLayout() and threadBranchPaths() from those modules and
// asserts the artifact's coordinates ARE those numbers — and that the pane's
// on-screen map carries the same ones. It fails if either surface moves alone:
// an exporter that painted its own braid, or a map component that stopped
// reading the layout leaf. It does NOT fail when the geometry itself changes,
// because then both surfaces move together, which is the whole idea.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import LabyrinthPane from '../panes/LabyrinthPane.svelte';
import {
  threadBranchPaths, threadLayout, type LayoutStep,
} from '../components/labyrinthLayout';
import { TONE_VARS } from '../components/labyrinthTone';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const RUN = {
  sessionId: 'ses_a', title: 'three stories at once', folder: 'origami-coder',
  cwd: 'C:/repos/origami-coder', updatedAt: '2026-07-29T10:00:00.000Z',
};

/** Mount, pick the run, deliver its steps, press Export, hand back the page. */
async function exportOf(steps: LayoutStep[], over: Record<string, unknown> = {}) {
  const rendered = render(LabyrinthPane);
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'historyList', sessions: [RUN] } }));
  await tick();
  await fireEvent.click(rendered.container.querySelector('.lab-run')!);
  await tick();
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'runStepsData', sessionId: 'ses_a', steps, truncated: false, total: steps.length, ...over },
  }));
  await tick();
  await fireEvent.click(rendered.container.querySelector('.lab-export')!);
  await tick();
  const html = String(posts().filter((p) => p.type === 'exportLabyrinth').pop()!.html);
  return { html, container: rendered.container, doc: new DOMParser().parseFromString(html, 'text/html') };
}

/** The artifact, in a DOM that RUNS its inline script — the only way to prove
 *  the drawer opens and a click paints, rather than that the markup looks right. */
function live(html: string) {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const d = dom.window.document;
  return {
    dom, d,
    click: (el: Element) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
    panel: () => d.getElementById('og-detail')!,
    node: (o: number) => d.querySelector(`#og-map [data-ordinal="${o}"]`)!,
    drawer: () => d.getElementById('og-drawer') as HTMLElement,
  };
}

const step = (ordinal: number, over: Partial<LayoutStep> = {}): LayoutStep =>
  ({ ordinal, kind: 'tool', title: `step ${ordinal}`, ...over } as LayoutStep);

/** One headline cell's value, found by its label rather than by position. */
const cellOf = (doc: Document, label: string): string | null =>
  Array.from(doc.querySelectorAll('.strip .cell'))
    .find((c) => flat(c.querySelector('.l')!.textContent) === label)
    ?.querySelector('.v')!.textContent ?? null;

// A run with everything thread's geometry actually decides: a tool on its lane,
// two delegated stretches (one that came back, one still running), main-thread
// turns taken WHILE they ran, and clocks that make the row axis the clock's.
const CONCURRENT: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'write two stories while we talk', startedAt: 1_000, tokens: { input: 900, output: 30 } }),
  step(1, { kind: 'subagent', tool: 'task', title: 'story #1', background: true, status: 'completed', startedAt: 1_200, endedAt: 120_000 }),
  step(2, { kind: 'reply', title: 'story #1 text', depth: 1, parentOrdinal: 1, startedAt: 119_000, tokens: { input: 1_400, output: 2_600 } }),
  step(3, { kind: 'subagent', tool: 'task', title: 'story #2', background: true, status: 'running', startedAt: 1_400 }),
  step(4, { kind: 'tool', tool: 'read', title: 'read notes.md', status: 'completed', startedAt: 2_000 }),
  step(5, { kind: 'reply', title: 'both are writing', startedAt: 3_000, usageMissing: true }),
  step(6, { kind: 'error', title: 'ProviderAuthError', status: 'error', startedAt: 4_000 }),
];

/** The real palette on the root, exactly as the webview has it at export time. */
let dropTheme = (): void => {};
beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
  const el = document.createElement('style');
  el.textContent = readFileSync(path.join(pkgRoot, 'webview/shared/theme.css'), 'utf8');
  document.head.appendChild(el);
  dropTheme = () => el.remove();
});
afterEach(() => { cleanup(); dropTheme(); });

describe('exported atlas — the thread is the SAME geometry as the in-app Thread view', () => {
  it('every marker sits exactly where labyrinthLayout puts it, in the file AND on screen', async () => {
    const { doc, container } = await exportOf(CONCURRENT);

    // What the PURE modules say, computed here with no DOM in the loop.
    const want = threadLayout(CONCURRENT);
    expect(want, 'precondition: the layout must actually place every step').toHaveLength(CONCURRENT.length);
    // ...and it is a real thread, not a straight line — otherwise this proves nothing.
    expect(new Set(want.map((p) => p.x)).size, 'a run with lanes and branches must use several columns')
      .toBeGreaterThan(2);

    const groups = Array.from(doc.querySelectorAll('#og-map [data-ordinal]'));
    expect(groups, 'one exported group per step').toHaveLength(CONCURRENT.length);

    // The FILE's coordinates are the pure module's coordinates.
    for (const p of want) {
      const g = doc.querySelector(`#og-map [data-ordinal="${p.step.ordinal}"]`)!;
      const c = g.querySelector('circle')!;
      expect(Number(c.getAttribute('cx')), `step ${p.step.ordinal} x drifted from threadLayout`).toBe(p.x);
      expect(Number(c.getAttribute('cy')), `step ${p.step.ordinal} y drifted from threadLayout`).toBe(p.y);
    }

    // ...and so are the PANE's, so the two surfaces are provably one geometry.
    const onScreen = Array.from(container.querySelectorAll('.lab-svg .marker'));
    expect(onScreen).toHaveLength(want.length);
    onScreen.forEach((m, i) => {
      expect(Number(m.getAttribute('cx')), `on-screen step ${i} x`).toBe(want[i]!.x);
      expect(Number(m.getAttribute('cy')), `on-screen step ${i} y`).toBe(want[i]!.y);
    });
  });

  it('the branch rails in the file are labyrinthRails\' own path strings, segment for segment', async () => {
    const { doc } = await exportOf(CONCURRENT);

    const rails = threadBranchPaths(CONCURRENT);
    expect(rails, 'precondition: this run delegates twice').toHaveLength(2);
    // One returned and one did not — so the set carries a merge AND an open end.
    expect(rails.filter((r) => r.open)).toHaveLength(1);
    expect(rails.some((r) => r.trail), 'a background branch must trail past its own last step').toBe(true);

    const want = rails.flatMap((r) => [r.depart, r.spine, r.trail, r.merge].filter((d): d is string => !!d));
    // Rail segments are the paths NOT inside a marker group (a node's own lane
    // connector and its kind glyph both live inside one).
    const drawn = Array.from(doc.querySelectorAll('#og-map path'))
      .filter((p) => !p.closest('[data-ordinal]'))
      .map((p) => p.getAttribute('d'));
    expect(new Set(drawn)).toEqual(new Set(want));
    // The open branch has no merge drawn — the export inherits that honesty too.
    const open = rails.find((r) => r.open)!;
    expect(open.merge).toBeNull();
    expect(drawn.filter((d) => d?.startsWith(`M ${open.x} ${open.endY} L`)), 'a merge was drawn for an open branch')
      .toHaveLength(0);
  });

  it('the CLOCK axis rides along: a turn taken mid-branch is drawn above later delegated steps', async () => {
    const { doc } = await exportOf(CONCURRENT);
    const y = (o: number) => Number(doc.querySelector(`#og-map [data-ordinal="${o}"] circle`)!.getAttribute('cy'));
    // #5 started at 3s, #2 at 119s — list order says otherwise, the clock does not.
    expect(y(5)).toBeLessThan(y(2));
    expect(y(4)).toBeLessThan(y(2));
  });
});

describe('exported atlas — the shape the owner picked', () => {
  it('is a console: pinned header + usage strip, filters, centred map, rail, ledger drawer', async () => {
    const { doc } = await exportOf(CONCURRENT);
    expect(doc.querySelector('header .brand')!.textContent).toContain('Labyrinth');
    expect(doc.querySelector('header .strip'), 'the usage strip belongs in the header').not.toBeNull();
    expect(doc.querySelector('#og-filters button')).not.toBeNull();
    // ONE map pane and ONE rail, side by side, with the map inside the pane.
    expect(doc.querySelector('main > .mapwrap > #og-map svg')).not.toBeNull();
    expect(doc.querySelector('main > aside.railwrap > #og-detail')).not.toBeNull();
    // The ledger is IN the drawer, and the drawer is shut. The raw table is not
    // the page — that is the whole reason this shape was chosen.
    expect(doc.querySelector('#og-drawer #og-ledger tbody tr')).not.toBeNull();
    expect((doc.getElementById('og-drawer') as HTMLElement).hidden).toBe(true);
  });

  it('drives: a node click fills the pinned rail, a kind filter dims, the drawer opens and shuts', async () => {
    const { html } = await exportOf(CONCURRENT);
    const v = live(html);
    expect(v.panel().textContent, 'precondition: the rail is idle').toContain('Select a step');

    v.click(v.node(4));
    expect(flat(v.panel().querySelector('.dt-title')!.textContent)).toBe('read notes.md');
    expect(v.panel().querySelector('.dt-kind')!.textContent).toBe('tool');

    // A failure is labelled as one in the rail rather than left to be inferred.
    v.click(v.node(6));
    expect(v.panel().querySelector('.dt-fail')!.textContent).toBe('FAILED');

    const subagent = v.d.querySelector('#og-filters button[data-filter="k:subagent"]')!;
    expect(flat(subagent.textContent), 'a kind chip states how many it has').toBe('subagent2');
    v.click(subagent);
    expect(v.node(1).hasAttribute('data-og-dim')).toBe(false);
    expect(v.node(4).hasAttribute('data-og-dim')).toBe(true);

    const toggle = v.d.getElementById('og-drawer-toggle')!;
    expect(v.drawer().hidden).toBe(true);
    v.click(toggle);
    expect(v.drawer().hidden).toBe(false);
    expect(toggle.textContent).toBe('Hide step ledger');
    v.click(v.d.getElementById('og-drawer-close')!);
    expect(v.drawer().hidden).toBe(true);
    expect(toggle.textContent).toBe('Show step ledger');
    v.dom.window.close();
  });

  it('the filter swatches take the map\'s OWN tone table — one colour language, not two', () => {
    const src = readFileSync(path.join(pkgRoot, 'webview/dashboard/components/LabyrinthNode.svelte'), 'utf8');
    const drawn = Object.fromEntries(
      [...src.matchAll(/\.tone-(\w+)\s*\{\s*color:\s*var\((--[\w-]+)\)/g)].map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(drawn).length, 'precondition: the map really does tone by kind').toBeGreaterThan(3);
    expect(TONE_VARS, 'the exported swatches and the map markers disagree about a kind').toEqual(drawn);
  });
});

describe('exported atlas — the headline total is honest', () => {
  const MEASURED = [
    step(0, { kind: 'prompt', title: 'ask', tokens: { input: 1_000, output: 200, reasoning: 50 }, startedAt: 0 }),
    step(1, { kind: 'reply', title: 'answer', tokens: { input: 2_000, output: 400 }, cost: 0, startedAt: 60_000, endedAt: 61_000 }),
  ];

  it('a fully measured run states its total flat — no hedge, and no floor note', async () => {
    const { doc } = await exportOf(MEASURED);
    const total = flat(doc.querySelector('.cell.total .v')!.textContent);
    expect(total).toBe('3,650tok'); // 3000 in + 600 out + 50 reasoning
    expect(total).not.toContain('≥');
    expect(doc.querySelector('.floor'), 'a complete total must not carry a caveat').toBeNull();
    expect(flat(cellOf(doc, 'Steps'))).toBe('2/ 2 measured');
    expect(flat(cellOf(doc, 'Wall'))).toBe('1m 1s');
  });

  it('a run with unmeasured steps says so — the total carries ≥ and the caveat names the count', async () => {
    const { doc } = await exportOf([
      ...MEASURED,
      step(2, { kind: 'thinking', title: 'no usage recorded', usageMissing: true, startedAt: 30_000 }),
      step(3, { kind: 'thinking', title: 'nor here', usageMissing: true, startedAt: 40_000 }),
    ]);
    expect(flat(doc.querySelector('.cell.total .v')!.textContent)).toBe('≥3,650tok');
    const floor = flat(doc.querySelector('.floor')!.textContent);
    expect(floor).toContain('floor, not the run');
    expect(floor).toContain('2 steps recorded no usage');
    // A step that recorded nothing contributes NOTHING — never a fabricated 0.
    expect(flat(cellOf(doc, 'Steps'))).toBe('4/ 2 measured');
  });

  it('a run that recorded no usage at all shows no strip rather than a row of zeroes', async () => {
    const { doc } = await exportOf([step(0, { kind: 'prompt', title: 'ask' }), step(1, { kind: 'reply', title: 'answer' })]);
    expect(doc.querySelector('.strip'), 'an empty strip claiming 0 tokens is a measurement never taken').toBeNull();
    expect(doc.querySelector('.floor')).toBeNull();
    // ...and the rest of the console is still there.
    expect(doc.querySelector('#og-filters button')).not.toBeNull();
  });
});

describe('exported atlas — run content is DATA on every new surface too', () => {
  // The atlas added surfaces the document version never had: a filter chip
  // labelled with a KIND, and that kind in a data-filter attribute and in a
  // colour lookup. All three are run content.
  const NASTY = 'x" onload="window.__PWNED__=1" data-x="';

  it('a hostile KIND cannot escape the filter chip, its attribute or its swatch', async () => {
    const { html, doc } = await exportOf([
      step(0, { kind: NASTY as LayoutStep['kind'], title: 'odd kind' }),
      step(1, { kind: 'reply', title: 'fine' }),
    ]);
    // The characters survive as TEXT (a quote is legal in an SVG text node and
    // in a table cell), so the claim is not "the bytes are absent" — it is that
    // no ATTRIBUTE was ever closed by them. The chip's own attribute is checked
    // as a string, and the whole document is checked for a live handler.
    expect(html, 'the kind reached an attribute unescaped').toContain('data-filter="k:x&quot; onload=&quot;');
    expect(doc.querySelectorAll('[onload]'), 'run content armed a handler').toHaveLength(0);
    // Found by reading the attribute, not by a selector — a selector carrying
    // this string is not parseable, which is rather the point of escaping it.
    const chipIn = (d: Document) => Array.from(d.querySelectorAll('#og-filters button'))
      .find((b) => b.getAttribute('data-filter') === `k:${NASTY}`)!;
    const chip = chipIn(doc);
    expect(chip, 'the chip must exist, with the hostile text as a VALUE').not.toBeUndefined();
    expect(flat(chip.textContent)).toContain(NASTY);
    // An unknown kind gets the neutral swatch, never a fabricated colour or a
    // fragment of the kind string smuggled into a style.
    const sw = chip.querySelector('.sw')!.getAttribute('style') ?? '';
    expect(sw).not.toContain(NASTY);
    expect(sw).toMatch(/^background:(#|rgb)/);

    const v = live(html);
    v.click(chipIn(v.d));
    expect(v.node(1).hasAttribute('data-og-dim'), 'the hostile kind still filters correctly').toBe(true);
    expect(v.node(0).hasAttribute('data-og-dim')).toBe(false);
    expect(v.dom.window.__PWNED__).toBeUndefined();
    v.dom.window.close();
  });

  it('no module that builds this page owns a markup SINK', () => {
    const files = [
      'labyrinthHtml.ts', 'labyrinthAtlas.ts', 'labyrinthAtlasCss.ts', 'labyrinthStrip.ts',
      'labyrinthLedger.ts', 'labyrinthReport.ts', 'labyrinthTone.ts', 'labyrinthExport.ts',
    ];
    // COMMENTS ARE STRIPPED FIRST, and that is not a loophole: these files
    // discuss the sinks they refuse to use (labyrinthExport.ts opens by naming
    // what a raw outerHTML dump loses). Scanning prose would make the guard fire
    // on its own documentation, and the fix for that would be to delete the
    // explanation — so the code is scanned and the prose is not.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    for (const f of files) {
      const src = strip(readFileSync(path.join(pkgRoot, 'webview/dashboard/components', f), 'utf8'));
      for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
        expect(src.includes(sink), `${f} reaches for ${sink} — run content must only ever be textContent`).toBe(false);
      }
    }
    // The stripper really does leave code behind — otherwise this passes empty.
    expect(strip(readFileSync(path.join(pkgRoot, 'webview/dashboard/components/labyrinthAtlas.ts'), 'utf8')))
      .toContain('export function esc');
  });
});
