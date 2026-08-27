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
import HistoryDropdown from './HistoryDropdown.svelte';

const ITEMS = [
  { id: 's1', title: 'Storm plan', meta: 'aetheron · 5 Aug' },
  { id: 's2', title: 'Parser rewrite', meta: 'origami · 4 Aug' },
];

const mount = (over: Record<string, unknown> = {}) => {
  const props = {
    items: ITEMS,
    loading: false,
    query: '',
    onQuery: vi.fn(),
    onPick: vi.fn(),
    onClose: vi.fn(),
    emptyText: 'No past chats yet.',
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
