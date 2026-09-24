// t-qlgav5 — the dock's whole-item paging arithmetic. jsdom has no layout,
// so these numbers are the only part of "no clipped item" that can be
// proven in a unit test.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DOCK_GAP, DOCK_ITEM_W, dockFit, dockPageStart } from './sidebarDockFit';

const TOTAL = 7;

describe('sidebarDockFit — one fit definition, not a second rule', () => {
  it('solves its COUNT from connectionCarouselFit.fitTiles rather than re-deriving the formula', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, 'sidebarDockFit.ts'), 'utf8');
    expect(src).toMatch(/import\s*\{\s*fitTiles\s*\}\s*from\s*'\.\.\/sidebar\/connectionCarouselFit'/);
    // The "how many ideal-width tiles fit" arithmetic — floor((track+gap)/(ideal+gap))
    // — must appear exactly once in the whole webview, in connectionCarouselFit.ts.
    const connSrc = readFileSync(path.join(here, '..', 'sidebar', 'connectionCarouselFit.ts'), 'utf8');
    expect(connSrc).toMatch(/Math\.floor\(\(trackW \+ gap\) \/ \(ideal \+ gap\)\)/);
    expect(src).not.toMatch(/Math\.floor\(.*\+ gap.*\/.*\+ gap.*\)/);
  });
});

describe('sidebarDockFit — whole items only, never a clipped one', () => {
  it('a wide pill (350px, the owner-verified default sidebar) fits all seven with no arrows', () => {
    const fit = dockFit(350, TOTAL);
    expect(fit).toEqual({ count: 7, arrows: false });
  });

  it('a narrow pill (220px, the owner-reported clipped screenshot) pages instead of clipping', () => {
    const fit = dockFit(220, TOTAL);
    expect(fit.arrows).toBe(true);
    expect(fit.count).toBeGreaterThan(0);
    expect(fit.count).toBeLessThan(TOTAL);
  });

  it('narrower still (200px) shows fewer whole items, never zero', () => {
    const at200 = dockFit(200, TOTAL);
    const at220 = dockFit(220, TOTAL);
    expect(at200.arrows).toBe(true);
    expect(at200.count).toBeGreaterThanOrEqual(1);
    expect(at200.count).toBeLessThanOrEqual(at220.count);
  });

  it('260px already clears the seven-item threshold — no arrows', () => {
    expect(dockFit(260, TOTAL)).toEqual({ count: 7, arrows: false });
  });

  it('every count at every width actually fits the space it was solved for', () => {
    for (const pillW of [140, 180, 200, 220, 240, 260, 300, 350, 500]) {
      const fit = dockFit(pillW, TOTAL);
      const inner = pillW - 16; // DOCK_PAD, mirrored — see sidebarDockFit.ts
      const reserved = fit.arrows ? 2 * (20 + DOCK_GAP) : 0; // DOCK_ARROW_W
      const spanned = fit.count * DOCK_ITEM_W + (fit.count - 1) * DOCK_GAP;
      expect(spanned, `pill ${pillW}px, count ${fit.count}`).toBeLessThanOrEqual(Math.max(0, inner - reserved) + 0.001);
    }
  });

  it('an unmeasured pill (0 width, jsdom\'s permanent state) shows everything rather than guessing almost nothing fits', () => {
    expect(dockFit(0, TOTAL)).toEqual({ count: TOTAL, arrows: false });
  });

  it('a zero-item dock (defensive) shows nothing rather than a bogus positive count', () => {
    expect(dockFit(350, 0)).toEqual({ count: 0, arrows: false });
  });
});

describe('sidebarDockFit — paging by whole items', () => {
  it('an arrow pages forward by exactly one page (the count) and stops at the last window', () => {
    expect(dockPageStart(0, 1, 7, 5)).toBe(2); // 5 fit, 2 left over — the last window starts at 2
    expect(dockPageStart(2, 1, 7, 5)).toBe(2); // already at the end, stays there
  });

  it('an arrow pages backward and stops at 0, never negative', () => {
    expect(dockPageStart(2, -1, 7, 5)).toBe(0);
    expect(dockPageStart(0, -1, 7, 5)).toBe(0);
  });

  it('when every item already fits, the window always starts at 0', () => {
    expect(dockPageStart(3, 1, 7, 7)).toBe(0);
  });
});
