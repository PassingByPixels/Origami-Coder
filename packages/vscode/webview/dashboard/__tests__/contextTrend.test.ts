// The host's ring and the shape it draws. jsdom has no layout, so nothing here reads a
// computed style — the polyline's `points` string IS the geometry, and that is what is
// asserted.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import {
  TREND_POINTS,
  contextTrend,
  forgetContextTrend,
  pushContextReading,
  resetContextTrend,
  trendField,
} from '../../../src/dashboard/contextTrend';
import { TREND_H, TREND_W, trendPoints } from '../components/contextTrendLine';
import ContextBreakdownCard from '../components/ContextBreakdownCard.svelte';
import type { ContextComposition } from '../components/contextComposition';

const composition: ContextComposition = {
  systemPrompt: 1800, tools: 4200, conversation: 106_900, estimated: true, method: 'chars/4',
};

beforeEach(() => resetContextTrend());
afterEach(() => cleanup());

describe('the host ring', () => {
  it('keeps readings in order, per session', () => {
    pushContextReading('a', 10);
    pushContextReading('b', 99);
    pushContextReading('a', 20);
    expect(contextTrend('a')).toEqual([10, 20]);
    expect(contextTrend('b')).toEqual([99]);
  });

  it(`keeps the last ${TREND_POINTS} and no more`, () => {
    for (let i = 1; i <= TREND_POINTS + 5; i++) pushContextReading('a', i * 1000);
    const ring = contextTrend('a') ?? [];
    expect(ring).toHaveLength(TREND_POINTS);
    expect(ring[0]).toBe(6000); // the first five fell off the front
    expect(ring[ring.length - 1]).toBe((TREND_POINTS + 5) * 1000);
  });

  it('drops a reading identical to the one before it — one moment, several frames', () => {
    pushContextReading('a', 40_000);
    pushContextReading('a', 40_000);
    pushContextReading('a', 41_000);
    pushContextReading('a', 40_000);
    expect(contextTrend('a')).toEqual([40_000, 41_000, 40_000]);
  });

  it('ignores a zero, a negative and a non-number rather than anchoring on them', () => {
    for (const junk of [0, -5, Number.NaN, 'lots', undefined, null]) pushContextReading('a', junk);
    expect(contextTrend('a')).toBeUndefined();
  });

  it('answers undefined for a session with no readings, and after it is forgotten', () => {
    expect(contextTrend('never-seen')).toBeUndefined();
    expect(trendField('never-seen')).toEqual({});
    pushContextReading('a', 10);
    expect(trendField('a')).toEqual({ trend: [10] });
    forgetContextTrend('a');
    expect(contextTrend('a')).toBeUndefined();
  });

  it('hands out a copy, so a consumer cannot edit the ring', () => {
    pushContextReading('a', 10);
    contextTrend('a')!.push(999);
    expect(contextTrend('a')).toEqual([10]);
  });
});

describe('the line', () => {
  it('spreads the series left to right and scales it from ZERO, not from its own floor', () => {
    // 0, half, full against a top of 40k: the y values must be the bottom, the middle and
    // the top of the box — a floor at the series minimum would put 20k on the bottom edge.
    const points = trendPoints([20_000, 30_000, 40_000]).split(' ').map((p) => p.split(',').map(Number));
    expect(points).toHaveLength(3);
    expect(points[0][0]).toBeLessThan(points[1][0]);
    expect(points[1][0]).toBeLessThan(points[2][0]);
    expect(points[2][1]).toBeLessThan(points[1][1]); // higher reading, smaller y
    expect(points[1][1]).toBeLessThan(points[0][1]);
    expect(points[2][1]).toBeCloseTo(1.5, 1); // the top reading sits at the padded top
    // 20k of a 40k top sits HALFWAY up a zero-based box. A scale that started at the
    // series minimum would put it on the bottom edge (~16.5) instead — that is the
    // difference this line exists to catch.
    expect(points[0][1]).toBeCloseTo(TREND_H / 2, 1);
    expect(points[0][1]).toBeLessThan(TREND_H - 3);
  });

  it('draws one reading as a flat line across the card, not a dot at the left edge', () => {
    const points = trendPoints([12_345]).split(' ').map((p) => p.split(',').map(Number));
    expect(points).toHaveLength(2);
    expect(points[0][1]).toBe(points[1][1]);
    expect(points[0][0]).toBeLessThan(2);
    expect(points[1][0]).toBeGreaterThan(TREND_W - 2);
  });

  it('draws nothing for no series at all', () => {
    expect(trendPoints(undefined)).toBe('');
    expect(trendPoints([])).toBe('');
  });

  it('never divides by zero on an all-zero series', () => {
    expect(trendPoints([0, 0])).not.toBe('');
    expect(trendPoints([0, 0])).not.toContain('NaN');
  });
});

describe('the card', () => {
  it('draws the sparkline from the host series', () => {
    const view = render(ContextBreakdownCard, { props: { composition, contextWindow: 200_000, trend: [10_000, 20_000] } });
    const line = view.container.querySelector('.ctx-card-sparkline');
    expect(line).not.toBeNull();
    expect(line?.getAttribute('points')).toBe(trendPoints([10_000, 20_000]));
  });

  it('draws it for a session with ONE reading', () => {
    const view = render(ContextBreakdownCard, { props: { composition, contextWindow: 200_000, trend: [10_000] } });
    expect(view.container.querySelector('.ctx-card-sparkline')?.getAttribute('points')?.split(' ')).toHaveLength(2);
  });

  it('an old host sends no trend — no sparkline, no empty box, no error', () => {
    const view = render(ContextBreakdownCard, { props: { composition, contextWindow: 200_000 } });
    expect(view.container.querySelector('.ctx-card-spark')).toBeNull();
    expect(view.container.querySelector('.ctx-card-bar')).not.toBeNull(); // the rest of the card is untouched
  });
});
