// HistoryDropdown — the "which past one?" panel, shared by the sidebar's Chats
// half and its Collabs half.
//
// It is deliberately presentational: the caller filters (a chat matches on
// title+folder, an archived collab on title alone) and this draws. So the
// contract asserted here is the one both mounts depend on — what a keystroke
// reports, what a click reports, and the three states the list can be in.
//
// The state trio is the part worth guarding. "Still asking the host", "asked
// and there is nothing" and "here they are" are three different facts, and a
// panel that folds any two of them together goes silent exactly when the user
// is waiting to be told something.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import HistoryDropdown from './HistoryDropdown.svelte';

const ITEMS = [
  { id: 's1', title: 'Storm plan', meta: 'aetheron · 5 Aug' },
  { id: 's2', title: 'Parser rewrite', meta: 'origami · 4 Aug' },
];

// A stand-in for the toolbar element HistoryDropdown anchors to (t-hb1o0e).
// jsdom's real getBoundingClientRect() is always a zero rect, so it is
// stubbed with fixed numbers the position/style assertions can check against.
function fakeAnchor(rect: Partial<DOMRect> = {}): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    top: 40, left: 12, width: 260, bottom: 76, right: 272, height: 36, x: 12, y: 40, toJSON() {},
    ...rect,
  });
  return el;
}

const mount = (over: Record<string, unknown> = {}) => {
  const props = {
    items: ITEMS,
    loading: false,
    query: '',
    onQuery: vi.fn(),
    onPick: vi.fn(),
    onClose: vi.fn(),
    emptyText: 'No past chats yet.',
    anchorEl: fakeAnchor(),
    ...over,
  };
  return { props, ...render(HistoryDropdown, props) };
};

afterEach(() => cleanup());

describe('HistoryDropdown — the search box reports what was typed', () => {
  it('calls onQuery on input, and never filters behind the caller’s back', async () => {
    const { props, container } = mount();
    const input = container.querySelector('.history-search') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'storm' } });

    expect(props.onQuery).toHaveBeenCalledWith('storm');
    // The list is whatever it was GIVEN: two mounts filter on different fields,
    // so a second filter here would silently override one of them.
    expect(container.querySelectorAll('.history-row')).toHaveLength(2);
  });

  it('shows the query it was given, so the box survives a re-render', () => {
    const { container } = mount({ query: 'parser' });
    expect((container.querySelector('.history-search') as HTMLInputElement).value).toBe('parser');
  });

  it('Escape closes rather than clearing — the panel was the thing in the way', async () => {
    const { props, container } = mount();
    await fireEvent.keyDown(container.querySelector('.history-search')!, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onQuery).not.toHaveBeenCalled();
  });
});

describe('HistoryDropdown — picking one hands back its id', () => {
  it('reports the id, not the row index or the title', async () => {
    const { props, container } = mount();
    await fireEvent.click(container.querySelectorAll('.history-row')[1] as HTMLElement);
    expect(props.onPick).toHaveBeenCalledWith('s2');
  });

  it('draws each row’s title and meta line', () => {
    const { container } = mount();
    const rows = Array.from(container.querySelectorAll('.history-row'));
    expect(rows.map((r) => r.querySelector('.history-title')?.textContent)).toEqual(['Storm plan', 'Parser rewrite']);
    expect(rows[0]!.querySelector('.history-meta')?.textContent).toBe('aetheron · 5 Aug');
  });

  it('omits the meta line entirely when the caller has none — no empty second row', () => {
    const { container } = mount({ items: [{ id: 'x', title: 'Bare' }] });
    expect(container.querySelector('.history-meta')).toBeNull();
  });

  it('falls back to the id for a row tooltip, and prefers an explicit one', () => {
    const { container } = mount({
      items: [{ id: 'x', title: 'Bare' }, { id: 'y', title: 'Old room', tooltip: 'read-only' }],
    });
    const rows = Array.from(container.querySelectorAll('.history-row'));
    expect(rows[0]!.getAttribute('title')).toBe('x');
    expect(rows[1]!.getAttribute('title')).toBe('read-only');
  });
});

describe('HistoryDropdown — loading, empty and populated are three different facts', () => {
  it('says it is loading, and shows neither rows nor the empty text', () => {
    const { container } = mount({ loading: true, items: [] });
    expect(container.querySelector('.history-empty')!.textContent).toBe('Loading…');
    expect(container.querySelectorAll('.history-row')).toHaveLength(0);
  });

  it('a loading panel never shows a stale "nothing here" while the answer is in flight', () => {
    const { container } = mount({ loading: true, items: [], emptyText: 'No past chats yet.' });
    expect(container.textContent).not.toContain('No past chats yet.');
  });

  it('says the caller’s own empty text once the answer is in', () => {
    const { container } = mount({ items: [], emptyText: 'No matches.' });
    expect(container.querySelector('.history-empty')!.textContent).toBe('No matches.');
  });
});

// t-463pb6 — the panel draws a mark and a switch, and decides NOTHING about
// either: which rows carry a mark is the caller's projection (historyKinds.ts),
// and the switch reports a click rather than filtering anything itself. Both
// assertions below are here because a panel that quietly filtered would make
// the caller's own filter untestable.
describe('HistoryDropdown — the kind mark', () => {
  const MIXED = [
    { id: 'o1', title: 'Parser rewrite', meta: 'origami · 4 Aug' },
    { id: 'c1', title: 'Terrain shader', meta: 'aetheron · 5 Aug', mark: 'CC', markTitle: 'Claude Code chat' },
  ];

  it('draws the mark on the marked row and on no other', () => {
    const { container } = mount({ items: MIXED });
    const rows = container.querySelectorAll('.history-row');

    expect(rows[0].querySelector('.history-mark')).toBeNull();
    expect(rows[1].querySelector('.history-mark')!.textContent).toBe('CC');
    expect(rows[1].querySelector('.history-mark')!.getAttribute('title')).toBe('Claude Code chat');
  });

  it('still hands back the row id when a marked row is clicked', async () => {
    const { props, container } = mount({ items: MIXED });
    await fireEvent.click(container.querySelectorAll('.history-row')[1]);

    expect(props.onPick).toHaveBeenCalledWith('c1');
  });
});

describe('HistoryDropdown — the show/hide switch', () => {
  it('is absent unless the caller passes one (the Collabs half has one kind)', () => {
    const { container } = mount();
    expect(container.querySelector('.kind-toggle')).toBeNull();
  });

  it('reports the flipped value and filters nothing itself', async () => {
    const onChange = vi.fn();
    const { container } = mount({ kindToggle: { on: true, mark: 'CC', onChange } });
    const button = container.querySelector('.kind-toggle') as HTMLButtonElement;

    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toContain('CC');
    await fireEvent.click(button);

    expect(onChange).toHaveBeenCalledWith(false);
    // The rows are the caller's; a click on the switch removes none of them.
    expect(container.querySelectorAll('.history-row')).toHaveLength(ITEMS.length);
  });

  it('says hidden, and offers to show, when it is off', () => {
    const { container } = mount({ kindToggle: { on: false, mark: 'CC', onChange: vi.fn() } });
    const button = container.querySelector('.kind-toggle') as HTMLButtonElement;

    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.textContent).toContain('hidden');
  });
});

// t-hb1o0e — the panel used to sit in normal flow (squeezed by whatever the
// caller rendered below it, and clipped by the scrolling column it lived
// in). It is now a fixed overlay anchored to the caller's toolbar rect, with
// a full-viewport backdrop behind it for outside-click-to-close.
describe('HistoryDropdown — floats as a fixed overlay anchored to the toolbar (t-hb1o0e)', () => {
  // jsdom does not apply CSS, so the STATIC position/z-index (set by the
  // .hd-overlay class, only present when anchorEl was given) is checked
  // against the source, same as this codebase's other CSS-source regex
  // checks; the DYNAMIC numbers (an inline style this component computes)
  // are checked against the real rendered DOM below.
  it('carries the fixed-overlay modifier class, whose rule is position: fixed above the sidebar (z-index)', () => {
    const src = readFileSync(join(__dirname, 'HistoryDropdown.svelte'), 'utf-8');
    expect(src).toMatch(/\.history-dropdown\.hd-overlay\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*\d+;/);
    const { container } = mount({ anchorEl: fakeAnchor() });
    expect(container.querySelector('.history-dropdown')!.classList.contains('hd-overlay')).toBe(true);
  });

  it('is placed at the anchor width, under the anchor bottom', () => {
    const { container } = mount({ anchorEl: fakeAnchor({ top: 40, left: 12, width: 260, bottom: 76 }) });
    const panel = container.querySelector('.history-dropdown') as HTMLElement;

    expect(panel.style.width).toBe('260px');
    expect(parseFloat(panel.style.top)).toBeGreaterThan(76); // below the anchor, not over it
  });

  it('bounds max-height to the space left to the viewport bottom, not the list content height', () => {
    Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true });
    const { container } = mount({ anchorEl: fakeAnchor({ top: 40, left: 12, width: 260, bottom: 76 }) });
    const panel = container.querySelector('.history-dropdown') as HTMLElement;

    expect(parseFloat(panel.style.maxHeight)).toBeLessThan(200);
  });

  it('renders a full-viewport backdrop behind the panel', () => {
    const { container } = mount();
    expect(container.querySelector('.history-backdrop')).not.toBeNull();
  });

  it('a click on the backdrop (outside the panel) closes it', async () => {
    const { props, container } = mount();
    await fireEvent.click(container.querySelector('.history-backdrop')!);
    expect(props.onClose).toHaveBeenCalled();
  });

  it('a click inside the panel never reaches the backdrop — it stays open', async () => {
    const { props, container } = mount();
    await fireEvent.click(container.querySelector('.history-dropdown')!);
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe('HistoryDropdown — the diagnostic footer (t-5nmtva)', () => {
  it('draws the note UNDER a list that has rows, so "no Claude chats" is visible beside Origami ones', () => {
    const { container } = mount({ note: 'No Claude Code chats. Scanned C:/x/projects — 12 project folders, looked for c--x.' });
    const note = container.querySelector('[data-testid="history-note"]') as HTMLElement;

    expect(note.textContent).toContain('12 project folders');
    expect(container.querySelectorAll('.history-row')).toHaveLength(ITEMS.length);
  });

  it('is absent while the host round trip is still out — loading is not an answer yet', () => {
    const { container } = mount({ items: [], loading: true, note: 'No Claude Code chats. Scanned C:/x.' });
    expect(container.querySelector('[data-testid="history-note"]')).toBeNull();
  });

  it('is absent when the caller passes none', () => {
    expect(mount().container.querySelector('[data-testid="history-note"]')).toBeNull();
  });
});
