// Pure-logic tests for labyrinthColumns.ts — no DOM, no component render. A
// clamp bug here would let a Labyrinth divider crush a column to nothing, or
// let one column swallow the whole pane.
import { describe, expect, it } from 'vitest';
import { clampColumnWidth, mapFitStyle, MIN_INDEX_WIDTH, MIN_INSPECT_WIDTH, DEFAULT_INDEX_WIDTH, DEFAULT_INSPECT_WIDTH } from './labyrinthColumns';

describe('clampColumnWidth', () => {
  it('passes a candidate through unchanged when well within bounds', () => {
    expect(clampColumnWidth(250, 1000, MIN_INDEX_WIDTH)).toBe(250);
  });

  it('floors at the minimum — a column cannot be dragged to nothing', () => {
    expect(clampColumnWidth(50, 1000, MIN_INDEX_WIDTH)).toBe(MIN_INDEX_WIDTH);
    expect(clampColumnWidth(-500, 1000, MIN_INDEX_WIDTH)).toBe(MIN_INDEX_WIDTH);
  });

  it('ceilings at 60% of the container — one column cannot swallow the whole pane', () => {
    expect(clampColumnWidth(900, 1000, MIN_INDEX_WIDTH)).toBe(600);
  });

  it('with no real container yet (jsdom, or a genuinely zero rect) only the floor applies', () => {
    expect(clampColumnWidth(50, 0, MIN_INSPECT_WIDTH)).toBe(MIN_INSPECT_WIDTH);
    expect(clampColumnWidth(5000, 0, MIN_INSPECT_WIDTH)).toBe(5000);
  });

  it('rounds a fractional candidate', () => {
    expect(clampColumnWidth(250.6, 1000, MIN_INDEX_WIDTH)).toBe(251);
  });

  it('the exported defaults match the panes CSS defaults, so a fresh drag starts from the width already on screen', () => {
    expect(DEFAULT_INDEX_WIDTH).toBe(300);
    expect(DEFAULT_INSPECT_WIDTH).toBe(340);
  });
});

// mapFitStyle — fit-to-width is a LAYOUT change, not a paint one. jsdom has no
// layout engine and vitest.config.mts does not set css:true, so no <style> ever
// reaches the test DOM: getComputedStyle would return "" here. The only honest
// check is the string this function returns.
describe('mapFitStyle', () => {
  it('with fit off, the map keeps its natural 1-unit-per-pixel box and the canvas scrolls', () => {
    expect(mapFitStyle(940, 364, 0)).toBe('min-width: 940px; height: 364px;');
    expect(mapFitStyle(940, 364, -5)).toBe('min-width: 940px; height: 364px;');
  });

  it('a map ALREADY narrower than the panel is never enlarged — fitScale never grows one', () => {
    expect(mapFitStyle(400, 300, 900)).toBe('min-width: 400px; height: 300px;');
  });

  it('scales the HEIGHT by the same factor as the width — a fixed height would letterbox it', () => {
    // 940 into 470 = k of 0.5, so the box must halve on BOTH axes.
    expect(mapFitStyle(940, 364, 470)).toBe('min-width: 0; height: 182px;');
  });

  it('drops min-width rather than transforming, so the layout box really shrinks', () => {
    // A transform would leave min-width at 940 and .lab-canvas would still scroll.
    expect(mapFitStyle(940, 364, 300)).not.toContain('940');
    expect(mapFitStyle(940, 364, 300)).toContain('min-width: 0');
  });
});
