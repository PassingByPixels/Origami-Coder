// agentMapFit.test.ts — t-ze0hwh: the agent map opens as a centred panel, fit to the width of the chat
// panel but capped at about 1.2x the pre-t-z1xlfy panel (min(620px, 94%) x min(520px, 92%)), not full screen.
// jsdom has no layout: the rule is tested as numbers, the action with stubbed client sizes.
import { describe, expect, it } from 'vitest';
import { fitMapPanel, mapPanelSize, PANEL_MAX_H, PANEL_MAX_W } from './agentMapFit';

describe('mapPanelSize', () => {
  it('the cap is about 1.2x the old 620 x 520 panel', () => {
    expect(PANEL_MAX_W / 620).toBeCloseTo(1.2, 1);
    expect(PANEL_MAX_H / 520).toBeCloseTo(1.2, 1);
  });

  it('a wide, tall chat panel gets the capped size, not the whole panel', () => {
    expect(mapPanelSize(1920, 1080)).toEqual({ w: PANEL_MAX_W, h: PANEL_MAX_H });
    expect(mapPanelSize(1920, 1080).w).toBeLessThan(1920 - 24);
  });

  it('a narrow panel: the map fits its width (94 %) and height (92 %)', () => {
    expect(mapPanelSize(400, 300)).toEqual({ w: 376, h: 276 });
  });

  it('only one side capped: the other still fits', () => {
    expect(mapPanelSize(1600, 500)).toEqual({ w: PANEL_MAX_W, h: 460 });
  });

  it('not measured yet (0, NaN): the cap, never 0', () => {
    expect(mapPanelSize(0, Number.NaN)).toEqual({ w: PANEL_MAX_W, h: PANEL_MAX_H });
  });
});

describe('fitMapPanel (action)', () => {
  const sized = (w: number, h: number) => {
    const parent = document.createElement('div');
    Object.defineProperty(parent, 'clientWidth', { configurable: true, value: w });
    Object.defineProperty(parent, 'clientHeight', { configurable: true, value: h });
    const node = document.createElement('div');
    parent.appendChild(node);
    return { parent, node };
  };

  it('sizes the panel from its parent (the scrim that covers the chat cell)', () => {
    const { node } = sized(1400, 900);
    fitMapPanel(node);
    expect([node.style.width, node.style.height]).toEqual([`${PANEL_MAX_W}px`, `${PANEL_MAX_H}px`]);
    const small = sized(500, 400).node;
    fitMapPanel(small);
    expect([small.style.width, small.style.height]).toEqual(['470px', '368px']);
  });

  it('re-sizes when the parent resizes, and stops watching on destroy', () => {
    const observers: Array<{ cb: () => void; disconnected: boolean }> = [];
    const win = window as unknown as { ResizeObserver?: unknown };
    const saved = win.ResizeObserver;
    win.ResizeObserver = class { o: { cb: () => void; disconnected: boolean }; constructor(cb: () => void) { this.o = { cb, disconnected: false }; observers.push(this.o); } observe() {} disconnect() { this.o.disconnected = true; } };
    try {
      const { parent, node } = sized(500, 400);
      const action = fitMapPanel(node);
      Object.defineProperty(parent, 'clientWidth', { configurable: true, value: 300 });
      observers[0].cb();
      expect(node.style.width).toBe('282px');
      action.destroy?.();
      expect(observers[0].disconnected).toBe(true);
    } finally {
      win.ResizeObserver = saved;
    }
  });
});
