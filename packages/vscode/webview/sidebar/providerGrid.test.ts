// The pure grid-vs-pills decision + traffic-light projection for the
// ControlStrip provider surface. Independent of the DOM — mirrors
// modelGrouping.test.ts.

import { describe, expect, it } from 'vitest';
import { useGrid, lightOf, gridLabel } from './providerGrid';

describe('useGrid — the grid is the layout, no pill phase', () => {
  it('is false with zero configured providers (the "+ Add provider" empty state, not an empty grid)', () => {
    expect(useGrid(0)).toBe(false);
  });

  it('is true from the very first configured provider', () => {
    expect(useGrid(1)).toBe(true);
    expect(useGrid(2)).toBe(true);
  });

  it('stays true at higher counts — there is no threshold to cross back under', () => {
    expect(useGrid(4)).toBe(true);
    expect(useGrid(5)).toBe(true);
    expect(useGrid(20)).toBe(true);
  });
});

describe('lightOf — the traffic light', () => {
  it('is green whenever live, regardless of a stale reason', () => {
    expect(lightOf({ live: true })).toBe('green');
    expect(lightOf({ live: true, reason: 'stale probe text' })).toBe('green');
  });

  it('is red when not live and the probe recorded a failure reason', () => {
    expect(lightOf({ live: false, reason: '401 invalid key' })).toBe('red');
  });

  it('is yellow when not live and there is no reason yet (probe unanswered)', () => {
    expect(lightOf({ live: false })).toBe('yellow');
  });

  it('treats an empty-string reason as no reason (yellow, not red)', () => {
    expect(lightOf({ live: false, reason: '' })).toBe('yellow');
  });
});

describe('gridLabel — the square tooltip/aria-label text', () => {
  it('is just the name when green', () => {
    expect(gridLabel({ name: 'LM Studio', live: true })).toBe('LM Studio');
  });

  it('is just the name when yellow (no reason to show)', () => {
    expect(gridLabel({ name: 'vLLM', live: false })).toBe('vLLM');
  });

  it('appends the reason when red', () => {
    expect(gridLabel({ name: 'OpenRouter', live: false, reason: '401 invalid key' })).toBe(
      'OpenRouter — 401 invalid key',
    );
  });

  it('falls back to the name alone if red but the reason is somehow empty', () => {
    expect(gridLabel({ name: 'OpenRouter', live: false, reason: '' })).toBe('OpenRouter');
  });
});
