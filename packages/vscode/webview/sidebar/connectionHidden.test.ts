// t-ysud6n: the connections strip scrolls sideways, and owner UAT read a tile
// scrolled out of view as a tile that was missing. The arrows now say how many
// tiles are hidden on each side. t-vikozs: a tile name line never breaks
// mid-word. jsdom has no layout, so the counts are proven here as arithmetic
// and in the carousel with a stubbed track width.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hiddenTiles } from './connectionHidden';
import ConnectionCarousel from './ConnectionCarousel.svelte';
import { CONN_GAP, fitTiles } from './connectionCarouselFit';

const W = 5 * 40 + 4 * CONN_GAP; // a track that holds exactly five 40px tiles

describe('hiddenTiles — how many whole tiles are out of view on each side', () => {
  const fit = fitTiles(W);
  const step = fit.width + CONN_GAP;

  it('nine tiles at the start: none before, four after', () => {
    expect(hiddenTiles(0, W, fit, 9)).toEqual({ before: 0, after: 4 });
  });

  it('scrolled to the end: four before, none after', () => {
    expect(hiddenTiles(4 * step, W, fit, 9)).toEqual({ before: 4, after: 0 });
  });

  it('one page in: two before, two after', () => {
    expect(hiddenTiles(2 * step, W, fit, 9)).toEqual({ before: 2, after: 2 });
  });

  it('everything fits: nothing hidden; an unmeasured track claims nothing', () => {
    expect(hiddenTiles(0, W, fit, 5)).toEqual({ before: 0, after: 0 });
    expect(hiddenTiles(0, 0, fitTiles(0), 9)).toEqual({ before: 0, after: 0 });
  });
});

describe('ConnectionCarousel — the Next arrow says what is hidden', () => {
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
  afterEach(() => {
    Object.defineProperty(Element.prototype, 'clientWidth', desc);
    cleanup();
  });

  it('nine tiles in a five-tile track: Next reads "4 more", Previous claims none', () => {
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get() { return (this as Element).classList.contains('conn-track') ? W : 0; },
    });
    const tiles = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, title: `P${i}`, label: 'P', light: '' as const, open: false }));
    render(ConnectionCarousel, { tiles, onPick: () => {}, onAdd: () => {} });
    expect(screen.getByRole('button', { name: 'Next connections (4 more)' }).textContent).toContain('4');
    expect(screen.getByRole('button', { name: 'Previous connections' })).toBeTruthy();
  });
});

describe('ConnectionPill — a name line never breaks mid-word (t-vikozs)', () => {
  const src = readFileSync(join(__dirname, 'ConnectionPill.svelte'), 'utf-8');
  const rule = src.match(/\.grid-line\s*\{[^}]*\}/)?.[0] ?? '';
  it('one line per name part, clipped with an ellipsis, not wrapped anywhere', () => {
    expect(rule).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/overflow:\s*hidden/);
  });
});
