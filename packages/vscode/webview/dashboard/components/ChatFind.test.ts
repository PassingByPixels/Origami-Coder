// Ctrl+F in a chat cell: the rules (chatFind.ts) and the bar that drives them
// (ChatFind.svelte), in ONE file for the reason ModeControl.test.ts is one file
// — this checkout is on a case-insensitive filesystem, where a sibling
// `chatFind.test.ts` would silently BE this file.
//
// Four rules, each wrong in a way no screenshot would show:
//  1. WHAT MATCHES. A transcript is a tree, not a string. Search each text node
//     alone and "run `npm test`" never matches "run npm" — the phrase a reader
//     sees as one. Join the nodes carelessly and the last word of one message
//     welds onto the first word of the next, producing a "match" that appears
//     nowhere on screen. Both directions are asserted below.
//  2. WHERE IT MATCHED. The count can be right while every offset is one out;
//     the proof used here is the range's OWN text, read back through
//     matchRange, not a restatement of the arithmetic that built it.
//  3. WHAT "NEXT" MEANS at the ends of the list, and on a list that shrank
//     under the reader because the chat streamed.
//  4. WHICH CELL claims the key when a grid shows many chats at once.
//
// ...and two ways the WIDGET goes wrong:
//  A. IT EATS KEYS WHILE SHUT. The window listener is bound for as long as the
//     chat pane lives, so an unguarded Escape here would swallow the key from
//     the confirm dialog, the question modal and the lightbox with nothing on
//     screen to explain it — the regression ImageLightbox.test.ts documents.
//     It is proved by the observable that carries it, `defaultPrevented`,
//     rather than by a spy on a prop no caller passes.
//  B. TWO BARS AT ONCE. Every cell mounts its own widget and every widget hears
//     the same Ctrl+F, so "exactly one open" is not a fact about the pane — it
//     is one each widget re-derives. The grid case drives two cells for it.
//
// jsdom has NO layout engine and vitest.config.mts does not set `css: true`, so
// no <style> reaches this DOM, and there is no CSS Custom Highlight API in it
// either: the bar's pinning and size, and the highlight colours themselves, are
// invisible here. The source assertions at the end cover what can be checked
// statically; how it LOOKS still needs a human eye.

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ChatFind from './ChatFind.svelte';
import {
  buildHaystack, cellIdOf, clearHighlights, findMatches, HL_ALL, HL_CURRENT,
  matchRange, paintHighlights, pickFindTarget, stepIndex,
} from './chatFind';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// chatFind.ts — the decisions, with no widget around them
// ---------------------------------------------------------------------------

/** A scroller whose innerHTML is written WITHOUT whitespace between tags, so
 *  every text node in the fixture is one the markup actually put there. */
function scroller(html: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'cell-messages';
  el.innerHTML = html;
  return el;
}

const texts = (root: HTMLElement, q: string) => findMatches(root, q).map((m) => matchRange(m).toString());

describe('chatFind — what matches', () => {
  it('finds a substring regardless of case', () => {
    const root = scroller('<div>Hello World</div>');
    expect(texts(root, 'hello')).toEqual(['Hello']);
    expect(texts(root, 'WOR')).toEqual(['Wor']);
  });

  it('matches nothing at all for an empty query — an unasked box has not failed', () => {
    expect(findMatches(scroller('<div>Hello World</div>'), '')).toEqual([]);
  });

  it('matches ACROSS an inline element, which is one phrase to the reader', () => {
    const root = scroller('<p>run <code>npm test</code> now</p>');
    expect(texts(root, 'run npm')).toEqual(['run npm']);
    expect(texts(root, 'test now')).toEqual(['test now']);
  });

  it('never matches ACROSS a block boundary, which is two phrases to the reader', () => {
    // Rendered, these are two separate messages; "foobar" appears nowhere.
    const root = scroller('<div>foo</div><div>bar</div>');
    expect(findMatches(root, 'oob')).toEqual([]);
    expect(texts(root, 'foo')).toEqual(['foo']);
    expect(texts(root, 'bar')).toEqual(['bar']);
  });

  it('reports repeats in document order and never overlapping', () => {
    expect(texts(scroller('<div>aaaa</div>'), 'aa')).toEqual(['aa', 'aa']);
  });

  it('walks the whole tree, deep and shallow alike', () => {
    const root = scroller('<div>one<span>two<b>three</b></span></div><div>two</div>');
    expect(texts(root, 'two')).toEqual(['two', 'two']);
  });

  it("joins a block's inline runs but separates the blocks", () => {
    expect(buildHaystack(scroller('<p>a<em>b</em>c</p><p>d</p>')).text).toBe('abc\nd');
  });
});

describe('chatFind — where it matched', () => {
  it('puts the range endpoints on the matched characters, not near them', () => {
    const root = scroller('<p>alpha <code>beta</code> gamma</p>');
    const [m] = findMatches(root, 'a bet');
    expect(m).toBeDefined();
    // Read the DOM back rather than the arithmetic: the range must SPAN the
    // element boundary, ending three characters into the <code>.
    expect(matchRange(m).toString()).toBe('a bet');
    expect(m.startNode.data).toBe('alpha ');
    expect(m.startOffset).toBe(4);
    expect(m.endNode.data).toBe('beta');
    expect(m.endOffset).toBe(3);
  });

  it('keeps offsets exact after a character that lower-cases to two', () => {
    // 'İ'.toLowerCase() is two code units. Folding the haystack with a plain
    // toLowerCase would shift every offset after it and paint the wrong word;
    // the match below is the one that would move.
    expect(texts(scroller('<div>İstanbul then target</div>'), 'target')).toEqual(['target']);
  });
});

describe('chatFind — what next means', () => {
  it('wraps forwards off the end and backwards off the front', () => {
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, -1)).toBe(1);
  });

  it('answers 0 with nothing to step through, never -1', () => {
    expect(stepIndex(0, 0, 1)).toBe(0);
    expect(stepIndex(0, 0, -1)).toBe(0);
  });

  it('folds an index left over from a longer list back into range', () => {
    // The chat streamed, the recount came back smaller, the reader pressed Enter.
    expect(stepIndex(9, 3, 1)).toBe(1);
    expect(stepIndex(9, 3, -1)).toBe(2);
  });
});

describe('chatFind — which cell claims the key', () => {
  it('gives it to the cell holding the caret, over the pointer and the order', () => {
    expect(pickFindTarget(['a', 'b', 'c'], 'c', 'b')).toBe('c');
  });

  it('gives it to the hovered cell when nothing is focused', () => {
    expect(pickFindTarget(['a', 'b', 'c'], null, 'b')).toBe('b');
  });

  it('falls back to the first cell on screen — the whole answer in single layout', () => {
    expect(pickFindTarget(['a', 'b'], null, null)).toBe('a');
    expect(pickFindTarget(['solo'], null, null)).toBe('solo');
  });

  it('IGNORES an id that is not on screen, at both arms', () => {
    // A stale active/hovered id would otherwise open find on a cell nobody can
    // see, and the key would appear to do nothing at all.
    expect(pickFindTarget(['a', 'b'], 'gone', null)).toBe('a');
    expect(pickFindTarget(['a', 'b'], null, 'gone')).toBe('a');
  });

  it('answers null when no cell is on screen', () => {
    expect(pickFindTarget([], 'a', 'b')).toBeNull();
  });
});

describe('chatFind — reading a cell id off the DOM', () => {
  it('finds the id from a deeply nested element', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div class="chat-cell" data-session-id="s7"><p><b><i id="deep">x</i></b></p></div>';
    expect(cellIdOf(wrap.querySelector('#deep'))).toBe('s7');
  });

  it('answers null for nothing focused, and for an element in no cell', () => {
    expect(cellIdOf(null)).toBeNull();
    expect(cellIdOf(document.createElement('span'))).toBeNull();
  });
});

describe('chatFind — the highlight guard', () => {
  it('answers false, and does not throw, where the Custom Highlight API is absent', () => {
    // jsdom has no CSS.highlights. The bar must still count, step and scroll;
    // only the colour is missing, and the caller is told so rather than thrown at.
    const matches = findMatches(scroller('<div>find me</div>'), 'me');
    expect(matches).toHaveLength(1);
    expect(paintHighlights(matches, 0)).toBe(false);
    expect(clearHighlights()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ChatFind.svelte — the bar itself
// ---------------------------------------------------------------------------

/** A cell shaped exactly like ChatPane's: the `.chat-cell` the arbitration
 *  enumerates, wrapping the `.cell-messages` scroller the search walks. */
function mountCell(id: string, html: string): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'chat-cell';
  cell.dataset.sessionId = id;
  cell.innerHTML = `<div class="cell-messages" data-session-id="${id}">${html}</div>`;
  document.body.appendChild(cell);
  return cell;
}

/** A real, cancellable key event — so `defaultPrevented` means what it says. */
async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(ev);
  await tick();
  return ev;
}

const ctrlF = () => press('f', { ctrlKey: true });
const bar = () => document.querySelector('.cf-bar');
const box = () => document.querySelector<HTMLInputElement>('.cf-input');
const counter = () => document.querySelector('.cf-count')?.textContent?.trim() ?? '';
const btn = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

async function type(text: string) {
  const el = box()!;
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
}

async function enter(shift = false) {
  box()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift, bubbles: true, cancelable: true }));
  await tick();
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('ChatFind — opening', () => {
  it('draws nothing until Ctrl+F', async () => {
    mountCell('s1', '<div>alpha</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    expect(bar()).toBeNull();
    await ctrlF();
    expect(bar()).not.toBeNull();
  });

  it('claims the key from the page and focuses the box', async () => {
    mountCell('s1', '<div>alpha</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    const ev = await ctrlF();
    expect(ev.defaultPrevented).toBe(true); // the webview's own find must not also open
    await tick();
    expect(document.activeElement).toBe(box());
  });

  it('opens on Cmd+F too, and NOT on a bare f or on Ctrl+Alt+F', async () => {
    mountCell('s1', '<div>alpha</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    await press('f');
    expect(bar()).toBeNull();
    await press('f', { ctrlKey: true, altKey: true });
    expect(bar()).toBeNull();
    await press('f', { metaKey: true });
    expect(bar()).not.toBeNull();
  });

  it('leaves Ctrl+Shift+F to VS Code — that is search-across-files, not find', async () => {
    mountCell('s1', '<div>alpha</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    const ev = await press('F', { ctrlKey: true, shiftKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(bar()).toBeNull();
    // ...but Caps Lock reports 'F' with no shift held, and that IS Ctrl+F.
    await press('F', { ctrlKey: true });
    expect(bar()).not.toBeNull();
  });

  it('re-selects the box instead of opening a second bar', async () => {
    mountCell('s1', '<div>alpha</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    await ctrlF();
    await type('alp');
    await ctrlF();
    await tick();
    expect(document.querySelectorAll('.cf-bar')).toHaveLength(1);
    expect(box()!.value).toBe('alp'); // the query survives — Ctrl+F is not a reset
    expect(document.activeElement).toBe(box());
  });
});

describe('ChatFind — counting and stepping', () => {
  const THREE = '<div>one two</div><div>two again</div><p>and <code>two</code></p>';

  it('counts as you type, and says 0/0 only once something was asked', async () => {
    mountCell('s1', THREE);
    render(ChatFind, { props: { sessionId: 's1' } });
    await ctrlF();
    expect(counter()).toBe('');
    await type('two');
    expect(counter()).toBe('1/3');
    await type('nowhere');
    expect(counter()).toBe('0/0');
  });

  it('steps forward on Enter and WRAPS off the end; Shift+Enter goes back', async () => {
    mountCell('s1', THREE);
    render(ChatFind, { props: { sessionId: 's1' } });
    await ctrlF();
    await type('two');
    await enter(); expect(counter()).toBe('2/3');
    await enter(); expect(counter()).toBe('3/3');
    await enter(); expect(counter()).toBe('1/3');
    await enter(true); expect(counter()).toBe('3/3');
  });

  it('steps on the arrows, backwards from the first match onto the last', async () => {
    mountCell('s1', THREE);
    render(ChatFind, { props: { sessionId: 's1' } });
    await ctrlF();
    await type('two');
    btn('Previous match').click();
    await tick();
    expect(counter()).toBe('3/3');
    btn('Next match').click();
    await tick();
    expect(counter()).toBe('1/3');
  });

  it('re-counts on the next step when the chat streamed a new match in', async () => {
    const cell = mountCell('s1', '<div>two</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    await ctrlF();
    await type('two');
    expect(counter()).toBe('1/1');
    cell.querySelector('.cell-messages')!.insertAdjacentHTML('beforeend', '<div>two more</div>');
    btn('Next match').click();
    await tick();
    expect(counter()).toBe('2/2');
  });
});

describe('ChatFind — closing', () => {
  it('closes on Escape and puts the caret back where it was', async () => {
    const cell = mountCell('s1', '<div>alpha</div>');
    const composer = document.createElement('textarea');
    cell.appendChild(composer);
    composer.focus();
    render(ChatFind, { props: { sessionId: 's1' } });
    await ctrlF();
    expect(document.activeElement).toBe(box());
    const esc = await press('Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(bar()).toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it('closes on the ✕', async () => {
    mountCell('s1', '<div>alpha</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    await ctrlF();
    btn('Close find').click();
    await tick();
    expect(bar()).toBeNull();
  });
});

describe('ChatFind — what it must NOT do', () => {
  // Failure A: the listener outlives every close.
  it('does NOT swallow Escape while it is shut', async () => {
    mountCell('s1', '<div>alpha</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    const ev = await press('Escape');
    expect(ev.defaultPrevented).toBe(false);
    expect(bar()).toBeNull();
  });

  it('does NOT swallow Escape after it has been opened and closed again', async () => {
    mountCell('s1', '<div>alpha</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    await ctrlF();
    await press('Escape');
    expect((await press('Escape')).defaultPrevented).toBe(false);
  });

  it('never takes Enter from the window — the composer keeps its send key', async () => {
    mountCell('s1', '<div>alpha</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    await ctrlF();
    expect((await press('Enter')).defaultPrevented).toBe(false);
  });

  it('leaves every other key alone while shut', async () => {
    mountCell('s1', '<div>alpha</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    for (const key of ['Escape', 'Enter', 'a', 'ArrowDown', 'Tab']) {
      expect((await press(key)).defaultPrevented, `${key} was swallowed while find was shut`).toBe(false);
    }
    expect(bar()).toBeNull();
  });

  it('takes its listener with it when the cell is unmounted', async () => {
    // A cell closes, or the layout drops back to single-up. A listener that
    // outlived its widget would keep claiming Ctrl+F for a chat that is gone.
    mountCell('s1', '<div>alpha</div>');
    const view = render(ChatFind, { props: { sessionId: 's1' } });
    await ctrlF();
    expect(bar()).not.toBeNull();
    view.unmount();
    await tick();
    expect(bar()).toBeNull();
    expect((await ctrlF()).defaultPrevented).toBe(false);
  });
});

describe('ChatFind — one bar across a grid of cells', () => {
  // Failure B: every cell hears the same key.
  it('opens on one cell only, and the loser closes when the caret moves', async () => {
    mountCell('s1', '<div>alpha</div>');
    const cell2 = mountCell('s2', '<div>beta</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    render(ChatFind, { props: { sessionId: 's2' } });

    await ctrlF();
    await tick();
    // Nothing focused and nothing hovered in jsdom -> the first cell on screen.
    expect(document.querySelectorAll('.cf-bar')).toHaveLength(1);
    await type('alpha');
    expect(counter()).toBe('1/1'); // it searched s1's transcript, not s2's

    // Put the caret inside the SECOND cell and ask again.
    const composer = document.createElement('textarea');
    cell2.appendChild(composer);
    composer.focus();
    await ctrlF();
    await tick();
    expect(document.querySelectorAll('.cf-bar')).toHaveLength(1);
    await type('beta');
    expect(counter()).toBe('1/1'); // ...and now s2's
  });
});

describe('ChatFind — the colour path, against a stand-in for the API jsdom lacks', () => {
  // The registry is maplike and `Highlight` takes ranges — that is the shape the
  // CSS Custom Highlight API publishes and the shape chatFind.ts writes through,
  // so a Map and a one-line constructor stand in for it honestly rather than
  // inventing a contract. Without them the whole colour path is unobservable
  // here, including the handover defect the last case covers.
  let reg: Map<string, unknown>;
  class FakeHighlight {
    ranges: unknown[];
    constructor(...r: unknown[]) { this.ranges = r; }
  }

  beforeEach(() => {
    reg = new Map();
    vi.stubGlobal('CSS', { highlights: reg });
    vi.stubGlobal('Highlight', FakeHighlight);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('registers all the matches and the current one under separate names', async () => {
    mountCell('s1', '<div>one two</div><div>two</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    await ctrlF();
    await type('two');
    expect((reg.get(HL_ALL) as FakeHighlight).ranges).toHaveLength(2);
    expect((reg.get(HL_CURRENT) as FakeHighlight).ranges).toHaveLength(1);
  });

  it('leaves no colour behind when the reader closes it', async () => {
    mountCell('s1', '<div>two</div>');
    render(ChatFind, { props: { sessionId: 's1' } });
    await ctrlF();
    await type('two');
    expect(reg.size).toBeGreaterThan(0);
    await press('Escape');
    expect(reg.size).toBe(0);
  });

  it("does NOT let the losing cell wipe the winner's fresh paint", async () => {
    // The handover, with a query already in the winner's box. The loser's
    // handler runs AFTER the winner's paint, so a clear there erases colour
    // that is one instant old rather than the stale colour it means to drop.
    mountCell('s1', '<div>alpha</div>');
    const cell2 = mountCell('s2', '<div>beta</div>');
    render(ChatFind, { props: { sessionId: 's1' } }); // listener registered first
    render(ChatFind, { props: { sessionId: 's2' } });

    await ctrlF();
    await type('alpha');
    const caret2 = document.createElement('textarea');
    cell2.appendChild(caret2);
    caret2.focus();
    await ctrlF();
    await type('beta');

    // ...and back to s1, whose query survived its own close.
    const caret1 = document.createElement('textarea');
    document.querySelector('.chat-cell[data-session-id="s1"]')!.appendChild(caret1);
    caret1.focus();
    await ctrlF();
    expect(box()!.value).toBe('alpha');
    expect(reg.get(HL_ALL), 's2 cleared the paint s1 had just made').toBeDefined();
  });
});

describe('ChatFind — what only the source can prove', () => {
  const src = readFileSync(path.join(here, 'ChatFind.svelte'), 'utf8');

  it('uses theme vars only — a literal colour goes invisible in one of the five themes', () => {
    const literals = [
      ...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
      ...src.matchAll(/\brgba?\(/g),
      ...src.matchAll(/\bhsla?\(/g),
    ].map((m) => m[0]);
    expect(literals, `ChatFind.svelte hard-codes ${literals.join(', ')}`).toEqual([]);
  });

  // The house drift guard for a mirror: the highlight names are declared in
  // chatFind.ts and again in this file's CSS, in two languages neither compiler
  // can see across. Rename one alone and matches stop being coloured with
  // nothing failing anywhere — so the regexes are BUILT from the constants
  // rather than restating them.
  it('registers the highlight rules GLOBALLY — a Range carries no scoping class', () => {
    for (const name of [HL_ALL, HL_CURRENT]) {
      expect(src, `no ::highlight(${name}) rule — chatFind.ts registers a highlight nothing styles`)
        .toMatch(new RegExp(`:global\\(::highlight\\(${name}\\)\\)`));
    }
  });

  it('binds no F-key: house rule, browser and extension UIs use chords only', () => {
    expect(src).not.toMatch(/['"]F(?:[1-9]|1[0-2])['"]/);
  });
});

describe('ChatFind — the ChatPane wiring it cannot work without', () => {
  const pane = readFileSync(path.join(here, '..', 'panes', 'ChatPane.svelte'), 'utf8');

  it('mounts the bar OUTSIDE the scroller it searches', () => {
    // Inside `.cell-messages`, the TreeWalker would reach the bar's own
    // placeholder text and the find would match itself.
    const mount = pane.indexOf('<ChatFind');
    expect(mount, 'ChatPane.svelte does not mount ChatFind').toBeGreaterThan(-1);
    expect(mount).toBeLessThan(pane.indexOf('<div class="cell-messages"'));
  });

  it('stamps the session id on `.chat-cell`, which is what the arbitration enumerates', () => {
    expect(pane).toMatch(/class="chat-cell"\s+data-session-id=\{cellSession\.id\}/);
  });
});
