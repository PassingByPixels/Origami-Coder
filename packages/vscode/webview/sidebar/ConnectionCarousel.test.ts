// The connections carousel as it is actually wired into the strip. The FIT is
// proven in connectionCarouselFit.test.ts (jsdom reports clientWidth 0, so the
// measured half of it cannot be exercised here and needs a browser); what this
// file pins is the shape the redesign asked for: arrows, named tiles, and an
// Add control that is NOT part of the scrolling track.
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, afterEach } from 'vitest';
import ConnectionCarousel from './ConnectionCarousel.svelte';

afterEach(cleanup);

const TILES = [
  { id: 'lmstudio', label: 'LM', title: 'LM Studio — Live', light: 'green' as const, open: false },
  { id: 'openrouter', label: 'OP', title: 'OpenRouter — Idle', light: '' as const, open: false },
];

function mount(tiles = TILES, onAdd = () => {}, onPick = (_id: string) => {}) {
  return render(ConnectionCarousel, { props: { tiles, onPick, onAdd } });
}

describe('ConnectionCarousel', () => {
  it('pages the connections with arrows on both sides of the track', () => {
    const { container } = mount();
    const arrows = container.querySelectorAll('.conn-arrow');
    expect(Array.from(arrows).map((a) => a.getAttribute('aria-label')))
      .toEqual(['Previous connections', 'Next connections']);
    const track = container.querySelector('.conn-track')!;
    expect(arrows[0].nextElementSibling).toBe(track);
    expect(track.nextElementSibling).toBe(arrows[1]);
  });

  it('keeps Add OUTSIDE the track, so it can never scroll out of reach', () => {
    const { container } = mount();
    const add = container.querySelector('.add-provider')!;
    expect(container.querySelector('.conn-track')!.contains(add)).toBe(false);
    expect(add.getAttribute('aria-label')).toBe('Add connection');
    // An icon, not a word: the strip's room belongs to the connections.
    expect(add.textContent!.trim()).toBe('');
    expect(add.querySelector('svg')).not.toBeNull();
  });

  it('shows each provider NAME on two lines instead of two initials', () => {
    const { container } = mount();
    const tiles = container.querySelectorAll('.grid-square');
    const lines = (n: Element) => Array.from(n.querySelectorAll('.grid-line')).map((l) => l.textContent);
    expect(lines(tiles[0])).toEqual(['LM', 'Studio']);
    expect(lines(tiles[1])).toEqual(['Open', 'Router']);
    // The full name + status stays in the warm tip/aria-label; the tile is small.
    expect(tiles[0].getAttribute('data-tip')).toBe('LM Studio — Live');
    expect(tiles[0].hasAttribute('title')).toBe(false); // t-v483ot: no native tooltip under the warm one
  });

  it('publishes a solved tile width the pills read, rather than a fixed size', () => {
    const { container } = mount();
    const style = (container.querySelector('.conn-carousel') as HTMLElement).getAttribute('style') ?? '';
    expect(style).toContain('--conn-tile-w');
    expect(style).toContain('--conn-gap: 6px');
  });

  it('a click on a tile picks that connection', async () => {
    const picked: string[] = [];
    const { container } = mount(TILES, () => {}, (id) => picked.push(id));
    await fireEvent.click(container.querySelectorAll('.grid-square')[1]);
    expect(picked).toEqual(['openrouter']);
  });

  it('with no connections there is no carousel at all — just the empty state', () => {
    const { container } = mount([]);
    expect(container.querySelector('.conn-carousel')).toBeNull();
    expect(container.querySelector('.add-provider')!.textContent).toContain('Add provider');
  });

  // change 30 — the in-use tile carries the accent border, forwarded straight
  // through from the tile's own `inuse` flag (ControlStrip.test.ts covers
  // deriving that flag from the host's modelStatus broadcast).
  it('forwards inuse to exactly the tile it is set on', () => {
    const { container } = mount([
      { ...TILES[0], inuse: true },
      { ...TILES[1], inuse: false },
    ]);
    const tiles = container.querySelectorAll('.grid-square');
    expect(tiles[0].classList.contains('inuse')).toBe(true);
    expect(tiles[1].classList.contains('inuse')).toBe(false);
  });
});
