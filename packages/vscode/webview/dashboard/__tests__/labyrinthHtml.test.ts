// The exported page as a REPORT (owner's UAT: "click a node and you get the
// stream's information"). labyrinthPane.test.ts already asserts the ARTIFACT as
// a string — self-contained, theme-resolved, escaped, truncation stated. These
// assert the part a string test structurally cannot see: the inline script
// actually RUNNING.
//
// That distinction has teeth. A `textContent` sink and an `innerHTML` sink
// produce byte-identical source until something executes them, so the injection
// tests below load the real artifact into a script-running DOM and click it.
// Break the painter to innerHTML and the `<img onerror>` becomes a live element;
// stop escaping `<` in the JSON block and a step titled `</script>` closes it
// early and the payload stops parsing. Both are proven by mutation.

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { labyrinthHtmlDoc, type HtmlStep } from '../components/labyrinthHtml';

/** A stand-in palette: the resolver's job is proven against real theme.css in
 *  labyrinthPane.test.ts, so here it only has to answer every name. */
const VARS = (name: string) => (name === '--og-bg' ? '#101010' : '#c0c0c0');

/** Two markers shaped exactly as labyrinthExport.ts emits them: classes gone,
 *  presentation inline, `data-ordinal` surviving on the group. */
function svgOf(ordinals: number[]): string {
  const g = ordinals
    .map((o) => `<g role="button" tabindex="0" data-ordinal="${o}" style="opacity:1;color:#c0c0c0">`
      + `<title>step ${o}</title>`
      + `<circle style="fill:transparent;stroke:none" cx="40" cy="${20 + o * 30}" r="15"></circle>`
      + `<circle style="fill:#101010;stroke:#c0c0c0;stroke-width:1.6" cx="40" cy="${20 + o * 30}" r="5.5"></circle>`
      + '</g>')
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">${g}</svg>`;
}

function step(ordinal: number, over: Partial<HtmlStep> = {}): HtmlStep {
  return { ordinal, kind: 'tool', title: `step ${ordinal}`, ...over };
}

function doc(steps: HtmlStep[], over: Record<string, unknown> = {}): string {
  return labyrinthHtmlDoc({
    mode: 'thread', svg: svgOf(steps.map((s) => s.ordinal)), steps,
    loaded: steps.length, truncated: false, total: steps.length,
    title: 'a run', folder: 'origami-coder', when: '2026-07-29T10:00:00.000Z', ...over,
  } as never, VARS);
}

/** The artifact, loaded into a DOM that RUNS its inline script. */
function live(html: string) {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const d = dom.window.document;
  const click = (el: Element) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return {
    dom, d, click,
    panel: () => d.getElementById('og-detail')!,
    node: (o: number) => d.querySelector(`#og-map [data-ordinal="${o}"]`)!,
    row: (o: number) => d.querySelector(`#og-ledger tr[data-ordinal="${o}"]`)!,
    labels: () => Array.from(d.querySelectorAll('#og-detail .dt-label')).map((e) => e.textContent),
    pairs: () => {
      const out: Record<string, string> = {};
      const labels = Array.from(d.querySelectorAll('#og-detail .dt-label'));
      const values = Array.from(d.querySelectorAll('#og-detail .dt-value'));
      labels.forEach((l, i) => { out[l.textContent ?? ''] = values[i]?.textContent ?? ''; });
      return out;
    },
  };
}

const RICH = step(1, {
  tool: 'read', title: 'read agent.ts', status: 'completed',
  startedAt: 1_700_000_001_000, endedAt: 1_700_000_002_500, durationMs: 1500,
  tokens: { input: 120, output: 40 }, model: 'qwen3-coder', agent: 'build',
  preview: 'the first lines of the file', depth: 1, parentOrdinal: 0,
});

describe('exported report — clicking a node gives the step its full detail', () => {
  it('a click on a MAP NODE fills the panel with every field the step recorded', () => {
    const v = live(doc([step(0, { kind: 'prompt', title: 'do the thing' }), RICH]));
    expect(v.panel().textContent, 'precondition: the panel is idle before any click').toContain('Select a step');

    v.click(v.node(1));

    const rows = v.pairs();
    expect(rows).toEqual({
      Tool: 'read', Status: 'completed', Started: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/),
      Ended: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/), Duration: '1.5s',
      Tokens: '120 in · 40 out', Model: 'qwen3-coder', Agent: 'build',
      'Sub-agent depth': '1', 'Branch of': '#0', Preview: 'the first lines of the file',
    });
    expect(v.panel().querySelector('.dt-head')!.textContent).toContain('tool');
    expect(v.panel().querySelector('.dt-ord')!.textContent).toBe('#1');
    expect(v.panel().querySelector('.dt-title')!.textContent).toBe('read agent.ts');
    v.dom.window.close();
  });

  it('a click on a TABLE ROW selects the same step — the two surfaces are one selection', () => {
    const v = live(doc([step(0, { kind: 'prompt', title: 'do the thing' }), RICH]));
    v.click(v.row(1));
    expect(v.panel().querySelector('.dt-title')!.textContent).toBe('read agent.ts');
    // ...and it is visible ON THE MAP, which is where the app shows selection.
    expect(v.node(1).hasAttribute('data-og-sel')).toBe(true);
    expect(v.node(0).hasAttribute('data-og-sel')).toBe(false);
    expect(v.row(1).hasAttribute('data-og-sel')).toBe(true);
    v.dom.window.close();
  });

  it('selecting a SECOND step moves the selection rather than accumulating it', () => {
    const v = live(doc([step(0, { kind: 'prompt', title: 'do the thing' }), RICH]));
    v.click(v.node(0));
    v.click(v.node(1));
    expect(v.d.querySelectorAll('[data-og-sel]')).toHaveLength(2); // the node AND its row
    expect(v.node(0).hasAttribute('data-og-sel')).toBe(false);
    expect(v.panel().querySelectorAll('.dt-title')).toHaveLength(1); // not two stacked details
    v.dom.window.close();
  });

  it('an ABSENT field earns NO row — never "undefined", never a fabricated 0', () => {
    const v = live(doc([step(0, { kind: 'prompt', title: 'bare', depth: 0 })]));
    v.click(v.node(0));
    expect(v.labels()).toEqual([]); // a step with nothing recorded shows nothing
    expect(v.panel().textContent).not.toContain('undefined');
    // ...but ordinal 0 is a STEP, not an absence, and it still names itself.
    expect(v.panel().querySelector('.dt-ord')!.textContent).toBe('#0');
    // depth 0 is the main thread, so it is not a sub-agent level.
    expect(v.labels()).not.toContain('Sub-agent depth');
    v.dom.window.close();
  });
});

describe('exported report — every token field is optional', () => {
  it('a payload carrying only input/output renders exactly those two', () => {
    const v = live(doc([step(0, { tokens: { input: 9, output: 3 } })]));
    v.click(v.node(0));
    expect(v.pairs().Tokens).toBe('9 in · 3 out');
    v.dom.window.close();
  });

  it('a payload carrying NO tokens has no Tokens row at all', () => {
    const v = live(doc([step(0, { model: 'm' })]));
    v.click(v.node(0));
    expect(v.labels()).toEqual(['Model']);
    v.dom.window.close();
  });

  it('reasoning / cache / cost are rendered when present and skipped when not', () => {
    // `cost` sits on the STEP, not in the token bag (RunStep/LayoutStep), and
    // the line is the inspector's own stepUsageText — so the exported report
    // and the pane print a run's usage identically.
    const rich = step(0, { tokens: { input: 9, output: 3, reasoning: 40, cache: { read: 7 } }, cost: 0.02 });
    const v = live(doc([rich]));
    v.click(v.node(0));
    // `cache write` is absent from the payload, so it must not appear at all.
    expect(v.pairs().Tokens).toBe('9 in · 3 out · 40 reasoning · 7 cache read · $0.02');
    v.dom.window.close();
  });

  it('a cost with NO tokens still earns the row, and a genuine $0 is kept', () => {
    const v = live(doc([step(0, { cost: 0 })]));
    v.click(v.node(0));
    expect(v.pairs().Tokens).toBe('$0');
    v.dom.window.close();
  });

  it('a zero token count is a MEASUREMENT and is kept', () => {
    const v = live(doc([step(0, { tokens: { input: 0, output: 0 } })]));
    v.click(v.node(0));
    expect(v.pairs().Tokens).toBe('0 in · 0 out');
    v.dom.window.close();
  });
});

// The hostile payload. Two details in it are load-bearing and were both found
// by mutation, not by inspection:
//
//  - the `<img onerror>` is BARE, not inside the comment. Commented-out markup
//    builds no element even through an innerHTML sink, so a commented img made
//    the injection assertion pass for the wrong reason.
//  - the ORDER is measured, not guessed. `</script`+whitespace comes FIRST,
//    before the `<!--` … `<script `+whitespace pair. Those sequences move the
//    HTML tokenizer between script-data, escaped and double-escaped states, and
//    with the pair leading they CANCEL — the block survives even against an
//    encoder that has stopped escaping `<`, so the test passed on a broken
//    export. Closer-first does not cancel: it ends the block immediately.
const HOSTILE = '</script foo</script><script>window.__PWNED__=1</script>'
  + '<img src=x onerror="window.__PWNED__=2">'
  + '<!-- a comment that reopens <script type=x -->& "quoted" \'single\'';

describe('exported report — run content is DATA, never markup', () => {
  it('a hostile title cannot break out of the embedded JSON block', () => {
    const html = doc([step(0, { title: HOSTILE }), step(1)]);
    // Two script tags ship (the JSON block + the painter) and no more: a
    // </script> from run content would have opened a third region.
    expect((html.match(/<\/script>/g) ?? [])).toHaveLength(2);
    expect(html.trimEnd().endsWith('</html>'), 'the document was truncated mid-way').toBe(true);

    const v = live(html);
    const payload = JSON.parse(v.d.getElementById('og-steps')!.textContent!);
    expect(payload, 'the JSON must still parse with the hostile title inside it').toHaveLength(2);
    expect(payload[0].title, 'the title must round-trip byte for byte').toBe(HOSTILE);
    v.dom.window.close();
  });

  it('a hostile title RENDERS as inert text, building no element and firing no handler', () => {
    const v = live(doc([step(0, { title: HOSTILE, preview: HOSTILE, error: HOSTILE })]));
    v.click(v.node(0));

    // Counts, not elements: a failed `toBeNull()` on a jsdom node makes the
    // reporter serialize the node, and the serializer's own error then buries
    // the actual result. A number fails legibly.
    expect(v.panel().querySelectorAll('img').length, 'run content became a live element').toBe(0);
    expect(v.panel().querySelectorAll('script').length, 'run content became an executable element').toBe(0);
    expect(v.dom.window.__PWNED__, 'a handler from run content armed').toBeUndefined();
    // ...and it is all there, as text a reader can actually see — three times.
    expect(v.panel().textContent).toContain(HOSTILE);
    expect(v.pairs().Preview).toBe(HOSTILE);
    expect(v.pairs().Error).toBe(HOSTILE);
    // The painter creates its OWN divs and nothing else: every element under
    // the panel is one it built. An innerHTML sink would put foreign tags here.
    const built = Array.from(v.panel().querySelectorAll('*'));
    expect(built.length).toBeGreaterThan(0);
    for (const el of built) {
      expect(el.tagName, `the painter built a ${el.tagName}`).toBe('DIV');
      expect(el.className).toMatch(/^dt-/);
    }
    v.dom.window.close();
  });

  it('the ledger row and the panel show the SAME hostile string, both escaped', () => {
    const v = live(doc([step(0, { title: HOSTILE })]));
    expect(v.row(0).querySelectorAll('td')[3]!.textContent).toBe(HOSTILE);
    expect(v.d.querySelectorAll('#og-ledger tbody tr')).toHaveLength(1);
    v.dom.window.close();
  });
});

describe('exported report — the payload and the ledger describe the same run', () => {
  it('one JSON record per table row, in step order', () => {
    const steps = [step(0, { kind: 'prompt' }), step(1), step(2, { kind: 'subagent' }), step(3, { kind: 'reply' })];
    const v = live(doc(steps));
    const payload = JSON.parse(v.d.getElementById('og-steps')!.textContent!);
    expect(payload).toHaveLength(v.d.querySelectorAll('#og-ledger tbody tr').length);
    expect(payload.map((p: { o: number }) => p.o)).toEqual([0, 1, 2, 3]);
    v.dom.window.close();
  });

  it('stays self-contained — nothing is fetched and no theme var survives', () => {
    const html = doc([step(0), RICH]);
    expect(html).not.toContain('var(--og-');
    expect(html).not.toContain('--og-');
    expect(html).not.toMatch(/<script[^>]*\bsrc\b/i);
    expect(html).not.toContain('<link');
    expect(html).not.toContain('src=');
    expect(html).not.toContain('@import');
  });
});

describe('exported report — the step filter', () => {
  const MIXED = [
    step(0, { kind: 'prompt', title: 'ask' }),
    step(1, { kind: 'tool', tool: 'bash', title: 'npm test', status: 'error' }),
    step(2, { kind: 'tool', tool: 'read', title: 'read it', status: 'completed' }),
  ];

  it('"Failures only" leaves the failing step and hides the rest, on BOTH surfaces', () => {
    const v = live(doc(MIXED));
    const fail = v.d.querySelector('#og-filters button[data-filter="!"]') as HTMLButtonElement;
    expect(fail, 'a run WITH a failure must offer the failures filter').not.toBeNull();
    v.click(fail);

    expect((v.row(1) as HTMLElement).hidden).toBe(false);
    expect((v.row(0) as HTMLElement).hidden).toBe(true);
    expect((v.row(2) as HTMLElement).hidden).toBe(true);
    expect(v.node(1).hasAttribute('data-og-dim')).toBe(false);
    expect(v.node(0).hasAttribute('data-og-dim')).toBe(true);
    expect(fail.getAttribute('aria-pressed')).toBe('true');
    v.dom.window.close();
  });

  it('a KIND filter keeps that kind, and "All steps" puts everything back', () => {
    const v = live(doc(MIXED));
    v.click(v.d.querySelector('#og-filters button[data-filter="k:tool"]')!);
    expect((v.row(0) as HTMLElement).hidden).toBe(true);
    expect((v.row(2) as HTMLElement).hidden).toBe(false);

    v.click(v.d.querySelector('#og-filters button[data-filter=""]')!);
    expect([0, 1, 2].map((o) => (v.row(o) as HTMLElement).hidden)).toEqual([false, false, false]);
    expect([0, 1, 2].map((o) => v.node(o).hasAttribute('data-og-dim'))).toEqual([false, false, false]);
    v.dom.window.close();
  });

  it('a run with NO failure is not offered a filter that could only empty the table', () => {
    const v = live(doc([step(0, { kind: 'prompt' }), step(1, { status: 'completed' })]));
    expect(v.d.querySelector('#og-filters button[data-filter="!"]')).toBeNull();
    expect(v.d.querySelectorAll('#og-filters button')).toHaveLength(3); // All + prompt + tool
    v.dom.window.close();
  });
});

describe('the Folio advert pill', () => {
  it('is one top-right LINK to origami.gratis with the exact line, and no network fetch', () => {
    const html = doc([step(0)]);
    const v = live(html);
    const ads = v.d.querySelectorAll('a.folio-ad');
    expect(ads).toHaveLength(1);
    expect(ads[0]!.getAttribute('href')).toBe('https://chromewebstore.google.com/detail/origami-folio/flhbdfakcooaomfaehhgenmmnlglhehk');
    expect(ads[0]!.getAttribute('rel')).toBe('noopener');
    expect(ads[0]!.textContent).toBe('Want Office Free in your browser? Try Origami Folio');
    // Self-containment holds: a LINK navigates only on click; nothing in the
    // artifact FETCHES (no img/iframe/external stylesheet for the advert).
    expect(html).not.toMatch(/<img|<iframe|<link/);
    v.dom.window.close();
  });
});
